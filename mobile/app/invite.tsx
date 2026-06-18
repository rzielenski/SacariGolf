/**
 * Invite Friends screen.
 *
 * Pulls /users/me/referral to get the caller's code + share URL and the
 * running tally of (a) accounts that have signed up with the code and
 * (b) Lucky Round perks earned from those signups. Tapping the share
 * button opens the OS share sheet — on iOS that includes a Copy action,
 * so we don't need to ship a separate clipboard native module (adding one
 * would force a new EAS build instead of an OTA).
 *
 * Reward is currently a Lucky Round perk per signup (see
 * backend/src/routes/auth.ts). When premium becomes paid that will
 * switch to a 7-day premium grant; the copy on this screen should be
 * updated to match at that point.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Share, Alert, ScrollView,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';

type Referral = Awaited<ReturnType<typeof api.users.referral>>;

export default function InviteScreen() {
  const [data, setData] = useState<Referral | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setData(await api.users.referral()); }
    catch (e: any) { Alert.alert('Could not load', e?.message ?? 'Try again.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onShare = useCallback(async () => {
    if (!data) return;
    const msg =
      `Come play Sacari Golf with me — ranked rounds, SR, shot-tracking and a Find Ranker for course discoveries. ` +
      `Sign up with my code and I get a Lucky Round perk.\n\n` +
      `Code: ${data.code}\n` +
      `${data.share_url}`;
    try {
      await Share.share({ message: msg, url: data.share_url });
    } catch (e: any) {
      // User cancelling the share sheet throws on iOS — silent is fine.
      if (e?.message && !/dismissed|cancelled/i.test(e.message)) {
        Alert.alert('Share failed', e.message);
      }
    }
  }, [data]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: 'Invite Friends',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
        {loading || !data ? (
          <View style={s.centered}><ActivityIndicator color={C.gold} size="large" /></View>
        ) : (
          <>
            {/* Hero card */}
            <View style={s.hero}>
              <Text style={s.heroLabel}>YOUR INVITE CODE</Text>
              <Text style={s.heroCode}>{data.code}</Text>
              <Text style={s.heroLink} numberOfLines={1} ellipsizeMode="middle">
                {data.share_url}
              </Text>
              <TouchableOpacity style={s.shareBtn} onPress={onShare} activeOpacity={0.85}>
                <Text style={s.shareBtnText}>Share link · Copy</Text>
              </TouchableOpacity>
              <Text style={s.shareHint}>
                Opens the share sheet — pick Copy, Messages, or any chat app.
              </Text>
            </View>

            {/* Stats */}
            <OrnamentTitle title="Your Referrals" />
            <View style={s.statsRow}>
              <View style={s.statCell}>
                <Text style={s.statVal}>{data.referred_count}</Text>
                <Text style={s.statLabel}>Friends invited</Text>
              </View>
              <View style={s.statDivider} />
              <View style={s.statCell}>
                <Text style={s.statVal}>{data.perks_earned}</Text>
                <Text style={s.statLabel}>Lucky Rounds earned</Text>
              </View>
            </View>

            {/* How it works */}
            <OrnamentTitle title="How it works" />
            <View style={s.howBlock}>
              <Step n="I" title="Share your link" body="Tap Share above and pick any app — Messages, WhatsApp, Discord, whatever." />
              <Step n="II" title="They sign up with your code" body="Your link lands them on a page with the code pre-filled. They enter it in the Sign Up form." />
              <Step n="III" title="You earn a Lucky Round" body="Per signup. A Lucky Round protects a loss or doubles a win in your next ranked match — auto-consumed." />
            </View>

            <TouchableOpacity onPress={() => router.back()} style={s.backLink}>
              <Text style={s.backLinkText}>← Back</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <View style={s.step}>
      <Text style={s.stepN}>{n}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.stepTitle}>{title}</Text>
        <Text style={s.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { alignItems: 'center', paddingTop: 80 },

  hero: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 2, borderColor: C.gold,
    padding: 22, alignItems: 'center', marginBottom: 18,
  },
  heroLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  heroCode: {
    fontFamily: F.serif, color: C.gold, fontSize: 42, fontWeight: '900',
    letterSpacing: 6, marginTop: 4,
  },
  heroLink: {
    color: C.textMuted, fontSize: 12, marginTop: 8,
    maxWidth: '100%',
  },
  shareBtn: {
    marginTop: 18, backgroundColor: C.gold, borderRadius: 8,
    paddingVertical: 12, paddingHorizontal: 28, alignItems: 'center',
  },
  shareBtnText: { color: C.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },
  shareHint: { color: C.textMuted, fontSize: 11, marginTop: 8 },

  statsRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 10, padding: 18,
    borderWidth: 1, borderColor: C.border, marginBottom: 18,
  },
  statCell: { flex: 1, alignItems: 'center' },
  statVal: { color: C.gold, fontSize: 32, fontWeight: '900', fontFamily: F.serif },
  statLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', marginTop: 4, letterSpacing: 0.5 },
  statDivider: { width: 1, height: 40, backgroundColor: C.border },

  howBlock: { marginBottom: 28 },
  step: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: C.card, borderRadius: 8, padding: 14,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  stepN: {
    color: C.gold, fontFamily: F.serif, fontSize: 22, fontWeight: '700',
    width: 30, textAlign: 'center', marginTop: 2,
  },
  stepTitle: { color: C.text, fontSize: 14, fontWeight: '900' },
  stepBody: { color: C.textMuted, fontSize: 13, lineHeight: 18, marginTop: 3 },

  backLink: { alignSelf: 'center', padding: 12 },
  backLinkText: { color: C.textMuted, fontSize: 13 },
});
