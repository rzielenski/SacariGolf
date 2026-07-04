/**
 * Dev-only avatar style lab. Navigate to `/dev/avatar-lab` (or via the "preview
 * art styles" link in the golfer builder) to compare professional avatar art
 * styles on a real device before committing to one.
 *
 * These render LIVE from DiceBear's HTTP API via <SvgUri> — so there's nothing
 * to install and zero bundling risk while we're just deciding. Once a style is
 * chosen, we bundle that DiceBear collection and generate avatars locally (no
 * network dependency) and wire it into the real builder (app/avatar.tsx).
 *
 * Licensing note per style is shown so the choice accounts for it: "free" = use
 * anywhere; "CC-BY" = usable commercially but needs a small "avatars by ___"
 * credit somewhere in the app.
 */
import { ScrollView, View, Text, StyleSheet, Dimensions } from 'react-native';
import { Stack } from 'expo-router';
import { SvgUri } from 'react-native-svg';
import { C, F } from '../../lib/colors';

const STYLES: { key: string; label: string; note: string }[] = [
  { key: 'avataaars',   label: 'Avataaars',   note: 'Closest to Bitmoji · bust · FREE' },
  { key: 'open-peeps',  label: 'Open Peeps',  note: 'Hand-drawn · full-body capable · FREE (CC0)' },
  { key: 'big-smile',   label: 'Big Smile',   note: 'Bright & clean · bust · CC-BY' },
  { key: 'personas',    label: 'Personas',    note: 'Modern flat · bust · CC-BY' },
  { key: 'adventurer',  label: 'Adventurer',  note: 'Detailed illustrated · bust · CC-BY' },
  { key: 'micah',       label: 'Micah',       note: 'Sleek minimal · bust · CC-BY' },
  { key: 'notionists',  label: 'Notionists',  note: 'Notion hand-drawn · bust · FREE' },
  { key: 'lorelei',     label: 'Lorelei',     note: 'Soft illustrated · bust · CC-BY' },
  { key: 'miniavs',     label: 'Miniavs',     note: 'Chibi cartoon · bust · CC-BY' },
  { key: 'thumbs',      label: 'Thumbs',      note: 'Simple/playful · FREE (CC0)' },
];

// A few sample "golfers" so each style shows some range, same seeds across
// styles so it's an apples-to-apples comparison.
const SEEDS = ['Ricky', 'Birdie', 'Sunny', 'Ace'];

const SCREEN_W = Dimensions.get('window').width;
const AV = Math.min(84, (SCREEN_W - 16 * 2 - 12 * 3) / 4);

function StyleRow({ styleKey, label, note }: { styleKey: string; label: string; note: string }) {
  return (
    <View style={s.card}>
      <Text style={s.styleName}>{label}</Text>
      <Text style={s.styleNote}>{note}</Text>
      <View style={s.row}>
        {SEEDS.map((seed) => (
          <View key={seed} style={[s.avBox, { width: AV, height: AV, borderRadius: AV / 2 }]}>
            <SvgUri
              width={AV}
              height={AV}
              uri={`https://api.dicebear.com/9.x/${styleKey}/svg?seed=${encodeURIComponent(seed)}`}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

export default function AvatarLab() {
  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Avatar Style Lab', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={s.intro}>
          Live samples from each pro avatar library. Pick the look you want and I'll bundle that
          one and wire it into the builder (rendered locally, no network). "FREE" = use anywhere;
          "CC-BY" = needs a small credit line.
        </Text>
        {STYLES.map((st) => (
          <StyleRow key={st.key} styleKey={st.key} label={st.label} note={st.note} />
        ))}
        <Text style={s.footer}>
          Loads over the network for this preview only. If a row is blank, check your connection
          and pull back to this screen.
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  intro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  card: {
    backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    padding: 14, marginBottom: 12,
  },
  styleName: { color: C.text, fontFamily: F.serif, fontSize: 18, fontWeight: '800' },
  styleNote: { color: C.gold, fontSize: 11.5, fontWeight: '700', marginTop: 2, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  avBox: {
    backgroundColor: '#eef1f5', overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
  },
  footer: { color: C.textDim, fontSize: 11, fontStyle: 'italic', textAlign: 'center', marginTop: 10, lineHeight: 16 },
});
