import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Stack } from 'expo-router';
import { api } from '../lib/api';
import { C } from '../lib/colors';
import { useAuth } from '../lib/auth';

const RARITY_COLOR: Record<string, string> = {
  common: '#9aa4b2', rare: '#5aa9e6', epic: '#b06bd6', legendary: '#d4a93f',
};

/** Earned titles — the catalog, what you've unlocked, and the one you've equipped.
 *  Tap an earned title to equip it (tap again to clear). */
export default function TitlesScreen() {
  const { refreshUser } = useAuth();
  const [titles, setTitles] = useState<Awaited<ReturnType<typeof api.titles.list>>['titles']>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.titles.list(); setTitles(d.titles); }
    catch { /* best-effort */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (t: { title_id: string; owned: boolean; equipped: boolean }) => {
    if (!t.owned || busy) return;
    setBusy(true);
    try {
      await api.titles.equip(t.equipped ? null : t.title_id);
      await load();
      refreshUser().catch(() => {});   // update the title flair on the profile
    } catch (e: any) { Alert.alert('Could not equip', e?.message ?? 'Try again.'); }
    finally { setBusy(false); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color={C.gold} size="large" /></View>;
  const owned = titles.filter((t) => t.owned).length;

  return (
    <ScrollView style={s.container} contentContainerStyle={{ padding: 18, paddingBottom: 60 }}>
      <Stack.Screen options={{ title: 'Titles', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />
      <Text style={s.intro}>Earned titles fly under your name. Tap an unlocked one to equip it. {owned}/{titles.length} unlocked.</Text>
      {titles.map((t) => {
        const color = RARITY_COLOR[t.rarity] ?? C.textMuted;
        return (
          <TouchableOpacity
            key={t.title_id}
            style={[s.row, t.equipped && { borderColor: C.gold, borderWidth: 2 }, !t.owned && { opacity: 0.5 }]}
            activeOpacity={t.owned ? 0.7 : 1}
            onPress={() => toggle(t)}
          >
            <View style={{ flex: 1 }}>
              <Text style={[s.name, { color: t.owned ? color : C.textMuted }]}>{t.owned ? t.name : `🔒 ${t.name}`}</Text>
              <Text style={s.desc}>{t.description}</Text>
            </View>
            <Text style={[s.rarity, { color }]}>{t.rarity.toUpperCase()}</Text>
            {t.equipped ? <Text style={s.equipped}>✓</Text> : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  intro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 8 },
  name: { fontWeight: '900', fontSize: 15 },
  desc: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  rarity: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  equipped: { color: C.gold, fontSize: 16, fontWeight: '900', marginLeft: 6 },
});
