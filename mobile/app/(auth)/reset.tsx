import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  ScrollView, Image,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { Divider } from '../../components/Flourish';

const SACARI_LOGO = require('../../assets/sacari-logo.jpg');

/**
 * Two-step "forgot password" flow:
 *   1) email → server emails a 6-digit code
 *   2) email + code + new password → server validates and signs the user in
 */
export default function ResetPasswordScreen() {
  const { email: emailParam } = useLocalSearchParams<{ email?: string }>();
  const [step, setStep] = useState<'email' | 'code'>(emailParam ? 'code' : 'email');
  const [email, setEmail] = useState(emailParam ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const codeRef = useRef<TextInput>(null);

  const { login } = useAuth();

  const requestCode = async () => {
    const e = email.trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      Alert.alert('Enter a valid email');
      return;
    }
    setLoading(true);
    try {
      await api.auth.forgotPassword(e);
      setStep('code');
      // Tiny delay so the focus shift feels intentional
      setTimeout(() => codeRef.current?.focus(), 100);
    } catch (err: any) {
      // Backend always responds success, so this only fires on network errors
      Alert.alert('Could not send code', err?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    const e = email.trim().toLowerCase();
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      Alert.alert('Enter the 6-digit code from your email');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Password too short', 'Use at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      // The reset endpoint also returns a token+user, but we use login() with
      // the new credentials so the AuthProvider state updates correctly and
      // AuthGuard navigates us into the app.
      await api.auth.resetPassword(e, c, password);
      await login(e, password);
      router.replace('/(tabs)/');
    } catch (err: any) {
      Alert.alert('Could not reset', err?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" bounces={false}>
        <View style={styles.logoBox}>
          <Image source={SACARI_LOGO} style={styles.logoImage} resizeMode="contain" />
          <Divider style={{ width: 200, marginTop: 4 }} />
        </View>

        <View style={styles.card}>
          {step === 'email' ? (
            <>
              <Text style={styles.cardTitle}>Reset password</Text>
              <Text style={styles.cardSub}>We'll email you a 6-digit code.</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="your@email.com"
                placeholderTextColor={C.textMuted}
                autoCapitalize="none"
                keyboardType="email-address"
                autoFocus
                returnKeyType="send"
                onSubmitEditing={requestCode}
              />
              <TouchableOpacity
                style={[styles.btn, loading && styles.btnDisabled]}
                onPress={requestCode}
                disabled={loading}
              >
                {loading
                  ? <ActivityIndicator color="#000" />
                  : <Text style={styles.btnText}>Send code</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <Text style={styles.backText}>← Back to sign in</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.cardTitle}>Enter code</Text>
              <Text style={styles.cardSub}>
                {`We sent a 6-digit code to ${email}.\nCheck your inbox (and spam folder).`}
              </Text>
              <TextInput
                ref={codeRef}
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                placeholderTextColor={C.textMuted}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
              />
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="New password (6+ chars)"
                placeholderTextColor={C.textMuted}
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
                  : <Text style={styles.btnText}>Reset password</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setStep('email'); setCode(''); setPassword(''); }} style={styles.backBtn}>
                <Text style={styles.backText}>← Use a different email</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={requestCode} disabled={loading} style={styles.resendBtn}>
                <Text style={styles.resendText}>Didn't get it? Send again</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 28 },
  logoBox: { alignItems: 'center', gap: 4 },
  logoImage: { width: 220, height: 220 },

  card: {
    backgroundColor: C.card, borderRadius: 20, padding: 24,
    borderWidth: 1, borderColor: C.border, gap: 12,
  },
  cardTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  cardSub: { color: C.textMuted, fontSize: 14, marginBottom: 4, lineHeight: 20 },

  input: {
    backgroundColor: C.bg, color: C.text, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 16,
    borderWidth: 1, borderColor: C.border,
  },
  codeInput: {
    fontFamily: F.mono, letterSpacing: 8, textAlign: 'center', fontSize: 22,
  },

  btn: { backgroundColor: C.gold, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#000', fontSize: 16, fontWeight: '800' },

  backBtn: { alignItems: 'center', marginTop: 8 },
  backText: { color: C.gold, fontSize: 14 },

  resendBtn: { alignItems: 'center', marginTop: 4, paddingVertical: 6 },
  resendText: { color: C.textMuted, fontSize: 13 },
});
