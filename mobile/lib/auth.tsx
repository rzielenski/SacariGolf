import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { api, setSessionInvalidHandler } from './api';
import { User } from '../types';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, referralCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Bumped on every logout / deleteAccount / session-invalid event. Any async
  // user fetch (refreshUser, the boot-time me() call, a racing profile-screen
  // refresh) snapshots this at call time and refuses to setUser() if it
  // changed underneath. Without this guard an in-flight request that resolves
  // a few ms AFTER logout re-populates `user`, AuthGuard sees it truthy again
  // and stays on /(tabs)/ — the user lands on a stale, zeroed-out profile and
  // has to tap Log Out a second time. See the logout() comment below.
  const authGenRef = useRef(0);

  useEffect(() => {
    (async () => {
      const gen = authGenRef.current;
      const stored = await AsyncStorage.getItem('coc_token');
      if (stored) {
        setToken(stored);
        try {
          const me = await api.users.me();
          if (gen === authGenRef.current) setUser(me);
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
      authGenRef.current += 1;
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

  const register = async (username: string, email: string, password: string, referralCode?: string) => {
    const { token: t, user: u } = await api.auth.register(username, email, password, referralCode);
    await AsyncStorage.setItem('coc_token', t);
    setToken(t);
    setUser(u);
  };

  const logout = async () => {
    // Order matters here. Three well-known races to dodge:
    //   1. If we navigate FIRST while user is still truthy, AuthGuard sees
    //      "user && inAuthGroup" and bounces us right back to /(tabs)/ —
    //      the user has to tap Log Out a second time for the second pass
    //      (with cleared state) to land on login.
    //   2. If we just clear state and rely on AuthGuard to redirect,
    //      sometimes the next render hasn't run yet and the user briefly
    //      sees a blank Profile screen (`if (!user) return null`).
    //   3. The Profile screen fires several user-fetch effects on focus
    //      (refreshUser, users.get, stats…). If one of those is in flight
    //      when Log Out is tapped, it resolves a moment later and its
    //      setUser() revives `user` — AuthGuard then keeps us on /(tabs)/
    //      showing a stale, zeroed-out profile, and the user has to tap
    //      Log Out again. Bumping authGenRef invalidates those in-flight
    //      fetches so their results are dropped (see refreshUser / boot).
    //
    // Fix: invalidate in-flight fetches, await the token removal so a racing
    // request can't read a still-valid token out of storage, clear state,
    // then defer the explicit redirect to the next frame so React has
    // committed the null user. By then AuthGuard also agrees we belong on
    // login, so no fight.
    authGenRef.current += 1;
    await AsyncStorage.removeItem('coc_token').catch(() => { });
    setToken(null);
    setUser(null);
    requestAnimationFrame(() => router.replace('/(auth)/login'));
  };

  const deleteAccount = async () => {
    // Try the server delete, but never let a network/auth error trap the user
    // in a half-logged-out state. We always end on the login screen with
    // local state cleared. Same race-avoidance pattern as logout() above.
    authGenRef.current += 1;
    try {
      await api.users.deleteAccount();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('deleteAccount: server call failed', err);
    }
    await AsyncStorage.removeItem('coc_token').catch(() => { });
    setToken(null);
    setUser(null);
    requestAnimationFrame(() => router.replace('/(auth)/login'));
  };

  const refreshUser = async () => {
    const gen = authGenRef.current;
    const me = await api.users.me();
    // A logout / deleteAccount / session-invalid event happened while this
    // request was in flight — drop the stale result instead of reviving the
    // logged-out user (which would strand them on a zeroed-out profile).
    if (gen !== authGenRef.current) return;
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
