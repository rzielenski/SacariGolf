import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
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
    await AsyncStorage.removeItem('coc_token');
    setToken(null);
    setUser(null);
  };

  const deleteAccount = async () => {
    await api.users.deleteAccount();
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
