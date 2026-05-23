/**
 * Instagram-style @mention text input.
 *
 *   <MentionInput value={body} onChangeText={setBody} style={...} multiline />
 *
 * A drop-in TextInput replacement that, when the cursor is inside an
 * `@handle` token, shows a dropdown of the user's friends filtered by what
 * they've typed so far. Tapping a suggestion autofills `@username `. Typing a
 * non-friend handle still works — the dropdown is purely an assist; the
 * server resolves whatever `@username` ends up in the text.
 *
 * Cursor handling: we track the caret from onSelectionChange (state, so the
 * suggestion list reacts to caret moves) but only *control* the selection
 * transiently right after an autofill — otherwise the native input owns the
 * caret, which avoids the classic controlled-selection cursor-jump on iOS.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { api } from '../lib/api';
import { C } from '../lib/colors';
import { UserAvatar } from './UserAvatar';

interface Friend { user_id: string; username: string; avatar_url?: string | null; }

interface Props {
  value: string;
  onChangeText: (t: string) => void;
  style?: any;
  placeholder?: string;
  placeholderTextColor?: string;
  multiline?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  /** Extra style for the suggestion dropdown (e.g. to cap its height). */
  dropdownStyle?: any;
}

/** If the caret sits inside an `@handle` token, return the partial handle and
 *  the index of the '@'. Returns null when there's no active mention (the
 *  caret is in plain text, or right after a non-word char). */
function getActiveMention(text: string, cursor: number): { partial: string; start: number } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') break;
    if (!/[a-zA-Z0-9_]/.test(ch)) return null; // hit a boundary before any '@'
    i--;
  }
  if (i < 0 || text[i] !== '@') return null;
  // '@' must start a word (avoid matching the @ in an email like "a@b").
  const before = i > 0 ? text[i - 1] : '';
  if (before && /[a-zA-Z0-9_]/.test(before)) return null;
  const partial = text.slice(i + 1, cursor);
  if (partial.length > 20) return null;
  return { partial, start: i };
}

export function MentionInput({
  value, onChangeText, style, placeholder, placeholderTextColor,
  multiline, maxLength, autoFocus, dropdownStyle,
}: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [cursor, setCursor] = useState(0);
  // Only set right after an autofill to reposition the caret; cleared as soon
  // as the native input reports its own selection, returning control to it.
  const [forcedSel, setForcedSel] = useState<{ start: number; end: number } | undefined>(undefined);
  const justPickedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.users.friends()
      .then((rows: any[]) => { if (!cancelled) setFriends(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* no friends / offline — dropdown just won't show */ });
    return () => { cancelled = true; };
  }, []);

  const active = getActiveMention(value, cursor);
  const suggestions = active
    ? friends
        .filter((f) => f.username?.toLowerCase().startsWith(active.partial.toLowerCase()))
        .slice(0, 6)
    : [];

  const pick = (f: Friend) => {
    if (!active) return;
    const insert = `@${f.username} `;
    const next = value.slice(0, active.start) + insert + value.slice(cursor);
    const pos = active.start + insert.length;
    justPickedRef.current = true;
    onChangeText(next);
    setCursor(pos);
    setForcedSel({ start: pos, end: pos });
  };

  return (
    <View>
      <TextInput
        style={style}
        value={value}
        onChangeText={onChangeText}
        selection={forcedSel}
        onSelectionChange={(e) => {
          setCursor(e.nativeEvent.selection.start);
          // Hand the caret back to the native input after an autofill.
          if (justPickedRef.current) { justPickedRef.current = false; }
          else if (forcedSel) { setForcedSel(undefined); }
        }}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        multiline={multiline}
        maxLength={maxLength}
        autoFocus={autoFocus}
      />
      {suggestions.length > 0 && (
        <View style={[mi.dropdown, dropdownStyle]}>
          {suggestions.map((f) => (
            <TouchableOpacity
              key={f.user_id}
              style={mi.row}
              activeOpacity={0.7}
              onPress={() => pick(f)}
            >
              <UserAvatar username={f.username} avatarUrl={f.avatar_url ?? null} size={28} borderRadius={14} />
              <Text style={mi.name} numberOfLines={1}>@{f.username}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const mi = StyleSheet.create({
  dropdown: {
    marginTop: 6,
    backgroundColor: C.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  name: { color: C.text, fontSize: 14, fontWeight: '700', flex: 1 },
});
