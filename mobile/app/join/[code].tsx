import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C } from '../../lib/colors';

/**
 * Deep-link join handler. A creator-league QR encodes sacari://join/<CODE>;
 * scanning it (with any phone camera) or tapping the link lands here, which
 * joins by code and forwards to the league. Waits for auth, then joins. A fan
 * who isn't signed in yet can still join with the code manually after sign-up.
 */
export default function JoinByCodeScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cc = (code ?? '').toString().trim().toUpperCase();
      if (!cc) { setError('That link has no league code.'); return; }
      if (!user) return; // wait for sign-in; effect re-runs when `user` arrives
      try {
        const res = await api.tournaments.joinByCode(cc);
        if (!cancelled) router.replace(`/tournament/${res.tournament_id}` as any);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Could not join that league.');
      }
    })();
    return () => { cancelled = true; };
  }, [code, user]);

  return (
    <View style={s.center}>
      {error ? (
        <>
          <Text style={s.err}>{error}</Text>
          <TouchableOpacity style={s.btn} onPress={() => router.replace('/creator-leagues' as any)}>
            <Text style={s.btnText}>Browse Creator Leagues</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <ActivityIndicator color={C.gold} size="large" />
          <Text style={s.sub}>Joining the league…</Text>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center', padding: 30 },
  err: { color: C.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  sub: { color: C.textMuted, fontSize: 13, marginTop: 12, textAlign: 'center' },
  btn: { marginTop: 18, backgroundColor: C.gold, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8 },
  btnText: { color: '#000', fontWeight: '900' },
});
