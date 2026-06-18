/**
 * Bag editor v2 — a list of `{code, label?}` entries instead of a grid of
 * toggleable chips. Each entry pairs a canonical category code (drives the
 * in-round picker filter, the heatmap, the auto-suggest pool) with an
 * optional free-text label so players can use brand names or yardage
 * tags ("Stealth 2", "Vokey 56°", "the bender") instead of bare codes.
 *
 * UX:
 *   • Top: current bag entries — large label, small code chip on the right,
 *     swipe-style "×" to remove. Tap an entry to rename it inline.
 *   • Bottom: "+ Add Club" opens a sheet listing every preset (driver, 3w,
 *     irons, wedges, putter). Tap a preset to add with its default name,
 *     OR type a custom name in the field at the top of the sheet, pick a
 *     category, and add.
 *
 * USGA caps the bag at 14 clubs — enforced at save time (and again on the
 * server). Less than 14 is fine; casual practice doesn't care.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, TextInput, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BagEntry } from '../types';
import { C, F } from '../lib/colors';
// Club catalogue + by-code lookup now live in lib/clubs.ts (single source
// shared with the in-round picker and club-stats). Aliased to the local names
// this screen already used so the rest of the file is unchanged.
import { CLUBS_CATALOG as CATALOG, CLUBS_BY_CODE as CATALOG_BY_CODE, slugClubCode } from '../lib/clubs';

const MAX_BAG = 14;

export default function BagScreen() {
  const { user, refreshUser } = useAuth();
  const [entries, setEntries] = useState<BagEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Seed from server (or normalise legacy string[] form if the cached user
  // object still has the old shape). Both shapes get coerced to BagEntry[].
  useEffect(() => {
    if (!user) return;
    const raw = user.clubs_in_bag;
    if (!Array.isArray(raw) || raw.length === 0) {
      // First visit / no saved bag → seed with the standard 14-club lineup
      // so the player prunes / renames instead of building from scratch.
      const std = ['driver', '3w', 'hybrid', '5i', '6i', '7i', '8i', '9i', 'pw', 'gw', 'sw', 'lw', 'putter'];
      setEntries(std.map((code) => ({ code })));
      return;
    }
    setEntries(raw.map((e: any) =>
      typeof e === 'string'
        ? { code: e }
        : { code: e.code, ...(e.label ? { label: e.label } : {}) }
    ));
  }, [user?.user_id]);

  const labelFor = (entry: BagEntry) =>
    entry.label?.trim() || CATALOG_BY_CODE[entry.code]?.defaultLabel || entry.code.toUpperCase();

  const removeAt = (idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
    setRenamingIndex(null);
  };

  // Reorder — the bag is saved (and rendered in the in-round picker) in exactly
  // the order you arrange it here.
  const move = (idx: number, dir: -1 | 1) => {
    setEntries((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setRenamingIndex(null);
  };

  const startRename = (idx: number) => {
    setRenamingIndex(idx);
    setRenameDraft(entries[idx].label ?? '');
  };

  const commitRename = () => {
    if (renamingIndex == null) return;
    const trimmed = renameDraft.trim().slice(0, 30);
    setEntries((prev) => prev.map((e, i) => {
      if (i !== renamingIndex) return e;
      return trimmed ? { code: e.code, label: trimmed } : { code: e.code };
    }));
    setRenamingIndex(null);
    setRenameDraft('');
  };

  const addEntry = (code: string, label?: string) => {
    if (entries.length >= MAX_BAG) {
      Alert.alert('Bag is full', `USGA rules cap your bag at ${MAX_BAG} clubs. Remove one before adding another.`);
      return;
    }
    const trimmed = label?.trim().slice(0, 30);
    setEntries((prev) => [...prev, trimmed ? { code, label: trimmed } : { code }]);
    setAddSheetOpen(false);
  };

  const handleSave = async () => {
    if (entries.length === 0) {
      Alert.alert(
        'Empty bag',
        'You need at least one club. To make every club eligible again, tap "Reset to All" instead.',
      );
      return;
    }
    setSaving(true);
    try {
      await api.users.update({ clubsInBag: entries });
      await refreshUser?.();
      router.back();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Alert.alert(
      'Reset Bag',
      'Clears your custom bag — every club will be eligible in the picker until you save a new one.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            try {
              await api.users.update({ clubsInBag: null });
              await refreshUser?.();
              router.back();
            } catch (e: any) {
              Alert.alert('Could not save', e?.message ?? 'Try again.');
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  };

  if (!user) return null;

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: 'My Bag', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      <View style={s.summary}>
        <Text style={s.summaryNum}>{entries.length}<Text style={s.summaryNumSlash}>/{MAX_BAG}</Text></Text>
        <Text style={s.summaryLabel}>clubs in bag</Text>
      </View>
      <Text style={s.hint}>
        Tap a club to rename it. Use ▲▼ to reorder, × to remove. Add a club below — a preset, or type any custom club.
      </Text>

      <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
        {entries.length === 0 && (
          <Text style={s.empty}>Empty bag. Add your first club below.</Text>
        )}
        {entries.map((entry, idx) => {
          const isRenaming = renamingIndex === idx;
          return (
            <View key={`${entry.code}-${idx}`} style={s.entry}>
              {isRenaming ? (
                <TextInput
                  style={s.entryInput}
                  value={renameDraft}
                  onChangeText={setRenameDraft}
                  placeholder={CATALOG_BY_CODE[entry.code]?.defaultLabel ?? entry.code}
                  placeholderTextColor={C.textMuted}
                  autoFocus
                  maxLength={30}
                  onSubmitEditing={commitRename}
                  onBlur={commitRename}
                  returnKeyType="done"
                />
              ) : (
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => startRename(idx)}
                  activeOpacity={0.7}
                >
                  <Text style={s.entryLabel}>{labelFor(entry)}</Text>
                  {entry.label && (
                    <Text style={s.entryDefault}>
                      {CATALOG_BY_CODE[entry.code]?.defaultLabel ?? entry.code}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
              <View style={s.entryCodeChip}>
                <Text style={s.entryCodeText}>{entry.code.toUpperCase()}</Text>
              </View>
              <View style={s.reorder}>
                <TouchableOpacity onPress={() => move(idx, -1)} disabled={idx === 0} hitSlop={{ top: 4, bottom: 2, left: 6, right: 6 }}>
                  <Text style={[s.reorderArrow, idx === 0 && { opacity: 0.25 }]}>▲</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => move(idx, 1)} disabled={idx === entries.length - 1} hitSlop={{ top: 2, bottom: 4, left: 6, right: 6 }}>
                  <Text style={[s.reorderArrow, idx === entries.length - 1 && { opacity: 0.25 }]}>▼</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={s.entryRemove}
                onPress={() => removeAt(idx)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={s.entryRemoveText}>×</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <TouchableOpacity
          style={s.addBtn}
          onPress={() => setAddSheetOpen(true)}
          disabled={entries.length >= MAX_BAG}
          activeOpacity={0.7}
        >
          <Text style={[s.addBtnText, entries.length >= MAX_BAG && { opacity: 0.4 }]}>
            + Add Club
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.resetBtn} onPress={handleReset} disabled={saving}>
          <Text style={s.resetBtnText}>Reset to All Clubs</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity
          style={[s.saveBtn, saving && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving
            ? <ActivityIndicator color="#000" />
            : <Text style={s.saveBtnText}>Save Bag</Text>}
        </TouchableOpacity>
      </View>

      <AddClubSheet
        visible={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onAdd={addEntry}
      />
    </KeyboardAvoidingView>
  );
}

/** The Add modal — top: text input + category dropdown for a fully custom
 *  entry. Below: grouped preset chips for one-tap adds (with the catalog's
 *  default label). Lets the user mix and match without leaving the editor. */
function AddClubSheet({
  visible, onClose, onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (code: string, label?: string) => void;
}) {
  const [customLabel, setCustomLabel] = useState('');
  const [customCode, setCustomCode] = useState<string>('driver');

  // Reset draft each time the sheet opens so the previous entry's text
  // doesn't linger.
  useEffect(() => { if (visible) { setCustomLabel(''); setCustomCode('driver'); } }, [visible]);

  const groups = useMemo(() => {
    const out: Record<string, typeof CATALOG> = {};
    for (const c of CATALOG) (out[c.group] ??= []).push(c);
    return out;
  }, []);

  const submitCustom = () => {
    const label = customLabel.trim();
    if (customCode === 'custom') {
      // Fully custom club — its own category, slugged from the name.
      const code = slugClubCode(label);
      if (!code) { Alert.alert('Name your club', 'Type a name so your custom club has its own category to track under.'); return; }
      onAdd(code, label);
      return;
    }
    onAdd(customCode, label || undefined);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={a.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={a.header}>
          <Text style={a.title}>Add a Club</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={a.close}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={a.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Custom-name path: type a label, pick a category, add. */}
          <Text style={a.sectionLabel}>CUSTOM NAME</Text>
          <Text style={a.helper}>Use your brand, loft, or nickname. Pick a preset category to group its stats, or "Own category" to track the club on its own.</Text>
          <TextInput
            style={a.input}
            value={customLabel}
            onChangeText={setCustomLabel}
            placeholder="e.g. Vokey 56°, Stealth 2, Big Bertha"
            placeholderTextColor={C.textMuted}
            maxLength={30}
            returnKeyType="done"
          />
          <Text style={[a.sectionLabel, { marginTop: 14 }]}>CATEGORY</Text>
          <View style={a.catBlock}>
            <Text style={a.catGroup}>Custom</Text>
            <View style={a.catGrid}>
              <TouchableOpacity
                style={[a.catChip, { minWidth: 120 }, customCode === 'custom' && a.catChipActive]}
                onPress={() => setCustomCode('custom')}
              >
                <Text style={[a.catChipText, customCode === 'custom' && a.catChipTextActive]}>OWN CATEGORY</Text>
              </TouchableOpacity>
            </View>
          </View>
          {Object.entries(groups).map(([group, items]) => (
            <View key={group} style={a.catBlock}>
              <Text style={a.catGroup}>{group}</Text>
              <View style={a.catGrid}>
                {items.map((c) => {
                  const active = customCode === c.code;
                  return (
                    <TouchableOpacity
                      key={c.code}
                      style={[a.catChip, active && a.catChipActive]}
                      onPress={() => setCustomCode(c.code)}
                    >
                      <Text style={[a.catChipText, active && a.catChipTextActive]}>{c.code.toUpperCase()}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
          <TouchableOpacity style={a.addCustomBtn} onPress={submitCustom}>
            <Text style={a.addCustomBtnText}>
              Add {customLabel.trim() || (CATALOG_BY_CODE[customCode]?.defaultLabel ?? customCode)}
            </Text>
          </TouchableOpacity>

          {/* Preset path: tap a preset to add it with its default label. */}
          <View style={a.divider}>
            <View style={a.dividerLine} />
            <Text style={a.dividerText}>OR PICK A PRESET</Text>
            <View style={a.dividerLine} />
          </View>
          {Object.entries(groups).map(([group, items]) => (
            <View key={`preset-${group}`} style={a.catBlock}>
              <Text style={a.catGroup}>{group}</Text>
              <View style={a.presetGrid}>
                {items.map((c) => (
                  <TouchableOpacity
                    key={`preset-${c.code}`}
                    style={a.presetChip}
                    onPress={() => onAdd(c.code)}
                  >
                    <Text style={a.presetChipLabel}>{c.defaultLabel}</Text>
                    <Text style={a.presetChipCode}>{c.code.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  summary: {
    flexDirection: 'row', alignItems: 'baseline', gap: 8,
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6,
  },
  summaryNum: { color: C.gold, fontFamily: F.serif, fontSize: 36, fontWeight: '900' },
  summaryNumSlash: { color: C.textMuted, fontFamily: F.serif, fontSize: 22, fontWeight: '600' },
  summaryLabel: { color: C.textMuted, fontSize: 13 },

  hint: { color: C.textMuted, fontSize: 11, paddingHorizontal: 20, paddingBottom: 10, lineHeight: 16 },

  list: { paddingHorizontal: 16, paddingBottom: 120 },
  empty: { color: C.textMuted, fontSize: 12, textAlign: 'center', padding: 24, fontStyle: 'italic' },

  entry: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  entryLabel: { color: C.text, fontSize: 15, fontWeight: '700' },
  entryDefault: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  entryInput: {
    flex: 1, color: C.text, fontSize: 15, fontWeight: '700',
    paddingVertical: 2,
    borderBottomWidth: 1, borderBottomColor: C.gold,
  },
  entryCodeChip: {
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
    backgroundColor: C.gold + '22', borderWidth: 1, borderColor: C.gold + '88',
  },
  entryCodeText: { color: C.gold, fontWeight: '900', fontSize: 11, letterSpacing: 0.5 },
  entryRemove: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
  },
  entryRemoveText: { color: C.textMuted, fontSize: 18, fontWeight: '900', lineHeight: 20 },
  reorder: { alignItems: 'center', justifyContent: 'center' },
  reorderArrow: { color: C.gold, fontSize: 13, fontWeight: '900', lineHeight: 15 },

  addBtn: {
    marginTop: 8, paddingVertical: 14, borderRadius: 8,
    borderWidth: 1, borderColor: C.gold, borderStyle: 'dashed',
    backgroundColor: C.gold + '11', alignItems: 'center',
  },
  addBtnText: { color: C.gold, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },

  resetBtn: {
    marginTop: 24, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: C.border, borderRadius: 6, backgroundColor: C.card,
  },
  resetBtnText: { color: C.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },

  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
  },
  saveBtn: {
    paddingVertical: 14, borderRadius: 6, alignItems: 'center', backgroundColor: C.gold,
  },
  saveBtnText: { color: '#000', fontWeight: '900', fontSize: 15, letterSpacing: 0.5 },
});

const a = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 16 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingBottom: 12,
  },
  title: { color: C.text, fontSize: 20, fontWeight: '900' },
  close: { color: C.gold, fontSize: 15, fontWeight: '700' },
  scrollContent: { padding: 20, paddingBottom: 80 },

  sectionLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 4 },
  helper: { color: C.textDim, fontSize: 12, marginBottom: 10 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 14,
    borderWidth: 1, borderColor: C.border,
  },

  catBlock: { marginBottom: 12 },
  catGroup: { color: C.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 6 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  catChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    minWidth: 52, alignItems: 'center',
  },
  catChipActive: { borderColor: C.gold, backgroundColor: C.gold },
  catChipText: { color: C.text, fontWeight: '800', fontSize: 12 },
  catChipTextActive: { color: C.bg },

  addCustomBtn: {
    marginTop: 16, paddingVertical: 14, borderRadius: 6,
    backgroundColor: C.gold, alignItems: 'center',
  },
  addCustomBtnText: { color: '#000', fontWeight: '900', fontSize: 14 },

  divider: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginVertical: 24,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.border },
  dividerText: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },

  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetChip: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
    minWidth: 110,
  },
  presetChipLabel: { color: C.text, fontWeight: '700', fontSize: 13 },
  presetChipCode: { color: C.textMuted, fontSize: 10, marginTop: 2, letterSpacing: 0.5 },
});
