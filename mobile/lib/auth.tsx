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
    // Navigate FIRST while we're still legitimately on a screen that has the
    // logout button — otherwise the calling screen's `if (!user) return null`
    // can render an empty frame and the redirect from AuthGuard sometimes
    // doesn't fire on the first tap (Alert dismissal + state propagation race).
    router.replace('/(auth)/login');
    await AsyncStorage.removeItem('coc_token');
    setToken(null);
    setUser(null);
  };

  const deleteAccount = async () => {
    // Try the server delete, but never let a network/auth error trap the user
    // in a half-logged-out state. We always end on the login screen with
    // local state cleared.
    try {
      await api.users.deleteAccount();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('deleteAccount: server call failed', err);
    }
    router.replace('/(auth)/login');
    await AsyncStorage.removeItem('coc_token');
    setToken(null);
    setUser(null);
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
