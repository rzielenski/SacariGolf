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
  /** Outer wrapper style — pass `{ flex: 1 }` when the input sits in a row
   *  next to a send button (chat / comment composers). */
  containerStyle?: any;
  /** Render the dropdown ABOVE the input (absolutely) instead of below.
   *  Use for bottom-anchored composers so suggestions pop upward. */
  dropdownAbove?: boolean;
  /** Optional people to suggest from instead of the user's friends — e.g.
   *  the participants of a match/clan chat, so non-friend opponents show up. */
  people?: Friend[];
  // Pass-through TextInput extras used by the chat composer.
  returnKeyType?: 'send' | 'done' | 'default';
  onSubmitEditing?: () => void;
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
  multiline, maxLength, autoFocus, dropdownStyle, containerStyle,
  dropdownAbove, people, returnKeyType, onSubmitEditing,
}: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [cursor, setCursor] = useState(0);
  // Only set right after an autofill to reposition the caret; cleared as soon
  // as the native input reports its own selection, returning control to it.
  const [forcedSel, setForcedSel] = useState<{ start: number; end: number } | undefined>(undefined);
  const justPickedRef = useRef(false);

  // Only fetch friends if the caller didn't supply an explicit people list.
  useEffect(() => {
    if (people) return;
    let cancelled = false;
    api.users.friends()
      .then((rows: any[]) => { if (!cancelled) setFriends(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* no friends / offline — dropdown just won't show */ });
    return () => { cancelled = true; };
  }, [people]);

  const source = people ?? friends;
  const active = getActiveMention(value, cursor);
  const suggestions = active
    ? source
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

  const dropdown = suggestions.length > 0 ? (
    <View style={[mi.dropdown, dropdownAbove && mi.dropdownAbove, dropdownStyle]}>
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
  ) : null;

  return (
    <View style={containerStyle}>
      {dropdownAbove && dropdown}
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
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
      />
      {!dropdownAbove && dropdown}
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
  // Bottom-anchored composers (chat / comments): float the list above the
  // input so it doesn't shove the row or get clipped under the keyboard.
  dropdownAbove: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginTop: 0,
    marginBottom: 6,
    zIndex: 50,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
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
