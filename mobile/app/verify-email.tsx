import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';

/**
 * Email verification screen. Reachable from the home-screen banner whenever
 * the user has email_verified === false.
 *   1. (Optional) tap "Resend code" → server emails a new 6-digit code
 *   2. Enter the code → server flips email_verified true → we refresh /me
 */
export default function VerifyEmailScreen() {
  const { user, refreshUser } = useAuth();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const codeRef = useRef<TextInput>(null);

  useEffect(() => {
    setTimeout(() => codeRef.current?.focus(), 100);
  }, []);

  // If they came here but they're already verified (e.g. linked via stale push),
  // bounce them back rather than showing a confusing form.
  useEffect(() => {
    if (user?.email_verified) {
      router.replace('/');
    }
  }, [user?.email_verified]);

  const submit = async () => {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      Alert.alert('Enter the 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const res = await api.auth.verifyEmail(c);
      await refreshUser();
      Alert.alert(
        res.alreadyVerified ? 'Already verified' : 'Email verified',
        res.alreadyVerified ? 'Your email was already confirmed.' : 'Thanks for confirming.',
        [{ text: 'OK', onPress: () => router.replace('/') }]
      );
    } catch (err: any) {
      Alert.alert('Could not verify', err?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      const res = await api.auth.resendVerification();
      if (res.alreadyVerified) {
        await refreshUser();
        router.replace('/');
        return;
      }
      Alert.alert('Code sent', 'Check your email for a new 6-digit code.');
    } catch (err: any) {
      Alert.alert('Could not send', err?.message ?? 'Try again.');
    } finally {
      setResending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" bounces={false}>
        <TouchableOpacity onPress={() => router.back()} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        <View style={styles.card}>
          <Text style={styles.title}>Verify your email</Text>
          <Text style={styles.sub}>
            {`We sent a 6-digit code to\n${user?.email ?? 'your email'}.`}
          </Text>

          <TextInput
            ref={codeRef}
            style={styles.codeInput}
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            placeholderTextColor={C.textMuted}
            keyboardType="number-pad"
            maxLength={6}
            returnKeyType="done"
            onSubmitEditing={submit}
          />

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={submit}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>Verify</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={resend} disabled={resending} style={styles.resendBtn}>
            {resending
              ? <ActivityIndicator color={C.textMuted} size="small" />
              : <Text style={styles.resendText}>Didn't get it? Resend code</Text>}
          </TouchableOpacity>
        </View>

        <Text style={styles.note}>
          Verifying confirms we have a working email for you so you can recover your password later.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 18 },

  cancelBtn: { position: 'absolute', top: 60, right: 20, padding: 8, zIndex: 10 },
  cancelText: { color: C.textMuted, fontSize: 14 },

  card: {
    backgroundColor: C.card, borderRadius: 20, padding: 24,
    borderWidth: 1, borderColor: C.border, gap: 14,
  },
  title: { color: C.text, fontSize: 22, fontWeight: '800', fontFamily: F.serif },
  sub: { color: C.textMuted, fontSize: 14, lineHeight: 20 },

  codeInput: {
    backgroundColor: C.bg, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 14, fontSize: 22,
    borderWidth: 1, borderColor: C.border,
    fontFamily: F.mono, letterSpacing: 8, textAlign: 'center',
  },

  btn: { backgroundColor: C.gold, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#000', fontSize: 16, fontWeight: '800' },

  resendBtn: { alignItems: 'center', paddingVertical: 6 },
  resendText: { color: C.gold, fontSize: 13, fontWeight: '600' },

  note: { color: C.textDim, fontSize: 12, textAlign: 'center', paddingHorizontal: 8, lineHeight: 18 },
});
