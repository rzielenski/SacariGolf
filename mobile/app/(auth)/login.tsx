import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Animated, ScrollView, Keyboard, Image,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { OfflineError } from '../../lib/api';
import { C, F } from '../../lib/colors';
import { Divider } from '../../components/Flourish';

const SACARI_LOGO = require('../../assets/sacari-logo.jpg');

export default function LoginScreen() {
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  // Optional invite code — pre-populated by tapping a /invite/<code> link
  // on the website would be ideal, but for the MVP the user types it in
  // by hand. Stored uppercased and stripped to [A-Z0-9] so paste-from-
  // marketing-copy ("Code: abc-123") still resolves.
  const [referral, setReferral] = useState('');
  const [step, setStep] = useState<'email' | 'password' | 'newuser'>('email');
  const [loading, setLoading] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const passwordRef = useRef<TextInput>(null);
  const nameRef = useRef<TextInput>(null);
  const referralRef = useRef<TextInput>(null);

  const fade = (cb: () => void) => {
    Keyboard.dismiss();
    Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      cb();
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  };

  const handleContinue = async () => {
    if (step === 'email') {
      if (!email.trim() || !email.includes('@')) {
        Alert.alert('Enter a valid email');
        return;
      }
      // Probe whether the account exists by attempting login with a sentinel
      // password. The backend answers 404 "No account with that email" for a
      // new user, or 401 (wrong password / Google account) for an existing
      // one. We branch on the HTTP STATUS, not the message text — so an
      // offline blip, timeout, rate-limit (429), or 5xx can NEVER misroute a
      // returning user into the Create-account form. Those stay put + alert.
      setLoading(true);
      try {
        await login(email.trim().toLowerCase(), '__check__');
        // A '__check__' password should never actually succeed; if it somehow
        // does, the user is signed in — send them home.
        router.replace('/');
      } catch (err: any) {
        const status = err?.status;
        if (status === 404) {
          fade(() => setStep('newuser'));
        } else if (status === 401) {
          fade(() => setStep('password'));
        } else {
          Alert.alert(
            'Could not check that email',
            err instanceof OfflineError
              ? 'You appear to be offline. Check your connection and try again.'
              : (err?.message || 'Something went wrong. Please try again.'),
          );
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    if (step === 'password') {
      if (!password) return;
      setLoading(true);
      try {
        await login(email.trim().toLowerCase(), password);
        router.replace('/');
      } catch (err: any) {
        // Only call it a wrong password when the server actually said so (401).
        // Offline / server errors get an honest title so the user doesn't
        // reset a password that was never wrong.
        if (err instanceof OfflineError) {
          Alert.alert('No connection', 'Check your connection and try again.');
        } else if (err?.status === 401) {
          Alert.alert('Wrong password', err.message);
        } else {
          Alert.alert('Sign in failed', err?.message || 'Please try again.');
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    if (step === 'newuser') {
      if (!name.trim() || !password) {
        Alert.alert('Fill in all fields');
        return;
      }
      if (password.length < 6) {
        Alert.alert('Password too short', 'Use at least 6 characters.');
        return;
      }
      setLoading(true);
      try {
          const username = name.trim();
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          Alert.alert('Invalid username', 'Use 3–20 characters: letters, numbers, or underscores. No spaces.');
          setLoading(false);
          return;
        }
        await register(
          username,
          email.trim().toLowerCase(),
          password,
          referral.trim().toUpperCase() || undefined,
        );
        router.replace('/');
      } catch (err: any) {
        Alert.alert('Error', err.message);
      } finally {
        setLoading(false);
      }
    }
  };

  const stepTitle = step === 'email'
    ? 'Welcome'
    : step === 'password'
    ? 'Welcome back'
    : 'Create account';

  const stepSub = step === 'email'
    ? 'Enter your email to continue'
    : step === 'password'
    ? email
    : 'Just a couple details';

  const btnLabel = step === 'email' ? 'Continue' : step === 'password' ? 'Sign In' : 'Start Playing';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Logo */}
        <View style={styles.logoBox}>
          <Image source={SACARI_LOGO} style={styles.logoImage} resizeMode="contain" />
          <Text style={styles.logoSub}>Est. 2026</Text>
          <Divider style={{ width: 200, marginTop: 4 }} />
        </View>

        {/* Form card */}
        <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
          <Text style={styles.cardTitle}>{stepTitle}</Text>
          <Text style={styles.cardSub} numberOfLines={1}>{stepSub}</Text>

          {/* Email — always visible */}
          {step === 'email' && (
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="your@email.com"
              placeholderTextColor={C.textMuted}
              returnKeyType="next"
              onSubmitEditing={handleContinue}
            />
          )}

          {/* Password */}
          {(step === 'password' || step === 'newuser') && (
            <TextInput
              ref={passwordRef}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={step === 'newuser' ? 'Choose a password (6+ chars)' : 'Password'}
              placeholderTextColor={C.textMuted}
              returnKeyType={step === 'newuser' ? 'next' : 'done'}
              onSubmitEditing={step === 'newuser' ? () => nameRef.current?.focus() : handleContinue}
            />
          )}

          {/* Username — new users only */}
          {step === 'newuser' && (
            <TextInput
              ref={nameRef}
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Choose a username (e.g. SwingKing99)"
              placeholderTextColor={C.textMuted}
              autoCapitalize="none"
              returnKeyType="next"
              onSubmitEditing={() => referralRef.current?.focus()}
              maxLength={20}
            />
          )}

          {/* Referral code — optional, new users only. Lands the inviter
              a Lucky Round perk. Stripped + uppercased on submit so a
              link-pasted "Code: abc-123" still resolves. */}
          {step === 'newuser' && (
            <TextInput
              ref={referralRef}
              style={[styles.input, { letterSpacing: 2 }]}
              value={referral}
              onChangeText={(v) => setReferral(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16))}
              placeholder="Referral code (optional)"
              placeholderTextColor={C.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleContinue}
              maxLength={16}
            />
          )}

          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleContinue}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>{btnLabel}</Text>}
          </TouchableOpacity>

          {step === 'password' && (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/(auth)/reset', params: { email: email.trim().toLowerCase() } } as any)}
              style={styles.forgotBtn}
            >
              <Text style={styles.forgotText}>Forgot password?</Text>
            </TouchableOpacity>
          )}

          {step !== 'email' && (
            <TouchableOpacity
              onPress={() => { fade(() => { setStep('email'); setPassword(''); setName(''); setReferral(''); }); }}
              style={styles.backBtn}
            >
              <Text style={styles.backText}>← Use a different email</Text>
            </TouchableOpacity>
          )}

          {step === 'newuser' && (
            <Text style={styles.eloNote}>You'll start in Wood and climb the ranks</Text>
          )}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 32 },
  logoBox: { alignItems: 'center', gap: 4 },
  logoImage: { width: 220, height: 220 },
  logoSub: { fontSize: 10, color: C.textDim, letterSpacing: 4, textTransform: 'uppercase' },

  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: C.border,
    gap: 12,
  },
  cardTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  cardSub: { color: C.textMuted, fontSize: 14, marginBottom: 4 },

  input: {
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: C.border,
  },

  btn: {
    backgroundColor: C.gold,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#000', fontWeight: '800', fontSize: 16 },

  backBtn: { alignItems: 'center', paddingVertical: 4 },
  backText: { color: C.textMuted, fontSize: 13 },
  forgotBtn: { alignItems: 'center', paddingVertical: 6, marginTop: -4 },
  forgotText: { color: C.gold, fontSize: 13, fontWeight: '600' },

  eloNote: { color: C.textDim, fontSize: 12, textAlign: 'center' },
});
