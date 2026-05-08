import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { api, setSessionInvalidHandler } from './api';
import { User } from '../types';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem('coc_token');
      if (stored) {
        setToken(stored);
        try {
          const me = await api.users.me();
          setUser(me);
        } catch {
          // Token invalid/expired — clear fully so AuthGuard redirects to login
          await AsyncStorage.removeItem('coc_token');
          setToken(null);
          setUser(null);
        }
      }
      setLoading(false);
    })();
  }, []);

  // Wire up the api layer so any backend 401 ("Missing token" / "Invalid
  // token") triggers a clean local logout instead of leaving the user in a
  // half-authenticated state where every subsequent call also fails.
  useEffect(() => {
    setSessionInvalidHandler(() => {
      AsyncStorage.removeItem('coc_token').catch(() => { });
      setToken(null);
      setUser(null);
      router.replace('/(auth)/login');
    });
    return () => setSessionInvalidHandler(null);
  }, []);

  const login = async (email: string, password: string) => {
    const { token: t, user: u } = await api.auth.login(email, password);
    await AsyncStorage.setItem('coc_token', t);
    setToken(t);
    setUser(u);
  };

  const register = async (username: string, email: string, password: string) => {
    const { token: t, user: u } = await api.auth.register(username, email, password);
    await AsyncStorage.setItem('coc_token', t);
    setToken(t);
    setUser(u);
  };

  const logout = async () => {
    // Order matters here. Two well-known races to dodge:
    //   1. If we navigate FIRST while user is still truthy, AuthGuard sees
    //      "user && inAuthGroup" and bounces us right back to /(tabs)/ —
    //      the user has to tap Log Out a second time for the second pass
    //      (with cleared state) to land on login.
    //   2. If we just clear state and rely on AuthGuard to redirect,
    //      sometimes the next render hasn't run yet and the user briefly
    //      sees a blank Profile screen (`if (!user) return null`).
    //
    // Fix: clear state synchronously, then defer the explicit redirect to
    // the next frame so React has committed the null user. By then AuthGuard
    // also agrees we belong on login, so no fight.
    setToken(null);
    setUser(null);
    AsyncStorage.removeItem('coc_token').catch(() => { });
    requestAnimationFrame(() => router.replace('/(auth)/login'));
  };

  const deleteAccount = async () => {
    // Try the server delete, but never let a network/auth error trap the user
    // in a half-logged-out state. We always end on the login screen with
    // local state cleared. Same race-avoidance pattern as logout() above.
    try {
      await api.users.deleteAccount();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('deleteAccount: server call failed', err);
    }
    setToken(null);
    setUser(null);
    AsyncStorage.removeItem('coc_token').catch(() => { });
    requestAnimationFrame(() => router.replace('/(auth)/login'));
  };

  const refreshUser = async () => {
    const me = await api.users.me();
    setUser(me);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, deleteAccount, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
