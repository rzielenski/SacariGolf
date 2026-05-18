/**
 * Request-a-course screen.
 *
 * Submitted entries land in the `course_requests` table on the server. An
 * admin reviews them by hand and (if legit) runs the normal course-import
 * flow. Nothing the user types here ever surfaces automatically in /nearby
 * or /search — keeping a hard manual gate is the cleanest way to avoid
 * junk data polluting the searchable catalog.
 *
 * Fields:
 *   • Course name — required
 *   • City / State / Country — optional but strongly encouraged
 *   • Website — optional, helps the admin verify it's a real course
 *   • Notes — anything else (tee colors known, par, GPS issues, etc.)
 */

import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

export default function CourseRequestScreen() {
  const [courseName, setCourseName] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const name = courseName.trim();
    if (!name) {
      Alert.alert('Course name required', 'Please enter at least the course name.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.courses.requestNew({
        courseName: name,
        city:    city.trim()    || undefined,
        state:   state.trim()   || undefined,
        country: country.trim() || undefined,
        website: website.trim() || undefined,
        notes:   notes.trim()   || undefined,
      });
      Alert.alert(
        res.duplicate ? 'Already submitted' : 'Request received',
        res.duplicate
          ? 'You already have an identical request pending review — thanks for the follow-up.'
          : "Thanks! We'll review it and add the course manually. You won't get a notification but check back in a few days.",
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (e: any) {
      Alert.alert('Could not submit', e?.message ?? 'Try again later.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Request a Course',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
          <Text style={s.intro}>
            Missing a course you play? Send us the details and we&apos;ll
            add it by hand within a few days.
          </Text>

          <Field label="Course name *">
            <TextInput
              style={s.input}
              value={courseName}
              onChangeText={setCourseName}
              placeholder="e.g. Pebble Beach Golf Links"
              placeholderTextColor={C.textMuted}
              autoCapitalize="words"
            />
          </Field>

          <View style={s.row}>
            <Field label="City" style={{ flex: 1 }}>
              <TextInput
                style={s.input}
                value={city}
                onChangeText={setCity}
                placeholder="City"
                placeholderTextColor={C.textMuted}
                autoCapitalize="words"
              />
            </Field>
            <Field label="State / Region" style={{ flex: 1 }}>
              <TextInput
                style={s.input}
                value={state}
                onChangeText={setState}
                placeholder="CA"
                placeholderTextColor={C.textMuted}
                autoCapitalize="characters"
              />
            </Field>
          </View>

          <Field label="Country">
            <TextInput
              style={s.input}
              value={country}
              onChangeText={setCountry}
              placeholder="USA"
              placeholderTextColor={C.textMuted}
              autoCapitalize="words"
            />
          </Field>

          <Field label="Website (optional)">
            <TextInput
              style={s.input}
              value={website}
              onChangeText={setWebsite}
              placeholder="https://..."
              placeholderTextColor={C.textMuted}
              autoCapitalize="none"
              keyboardType="url"
              autoCorrect={false}
            />
          </Field>

          <Field label="Notes (optional)">
            <TextInput
              style={[s.input, s.textarea]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Tee colors, par, anything that helps us add it accurately…"
              placeholderTextColor={C.textMuted}
              multiline
              numberOfLines={4}
            />
          </Field>

          <TouchableOpacity
            style={[s.submitBtn, submitting && { opacity: 0.5 }]}
            onPress={submit}
            disabled={submitting}
            activeOpacity={0.7}
          >
            {submitting
              ? <ActivityIndicator color={C.bg} />
              : <Text style={s.submitText}>SUBMIT REQUEST</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Field({
  label, children, style,
}: { label: string; children: React.ReactNode; style?: any }) {
  return (
    <View style={[{ marginBottom: 14 }, style]}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  intro: {
    color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 20,
  },
  row: { flexDirection: 'row', gap: 10 },
  label: {
    color: C.gold, fontSize: 11, fontWeight: '900',
    letterSpacing: 1.2, marginBottom: 6,
  },
  input: {
    backgroundColor: C.card,
    color: C.text,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  textarea: { minHeight: 90, textAlignVertical: 'top' },
  submitBtn: {
    marginTop: 14,
    backgroundColor: C.gold,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitText: {
    color: C.bg, fontFamily: F.serif, fontSize: 14,
    fontWeight: '900', letterSpacing: 1.5,
  },
});
