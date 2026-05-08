import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { C, F } from '../../../lib/colors';
import { ChatMessage } from '../../../types';

export default function ChatScreen() {
  const { type, id, name } = useLocalSearchParams<{ type: 'match' | 'clan' | 'dm'; id: string; name?: string }>();
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const params = type === 'match' ? { matchId: id } : type === 'clan' ? { clanId: id } : { toUserId: id };
      const data = await api.messages.list(params);
      setMessages(data);
    } catch { /* silent */ } finally { setLoading(false); }
  }, [type, id]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText('');
    try {
      const params = type === 'match'
        ? { matchId: id, body: trimmed }
        : type === 'clan'
        ? { clanId: id, body: trimmed }
        : { toUserId: id, body: trimmed };
      const msg = await api.messages.send(params);
      // Race-safe append: if a poll fired between the POST being committed
      // server-side and its response coming back, the polled list may
      // already contain this message. Dedupe by message_id so we don't
      // briefly show two copies (the duplicate would otherwise vanish on
      // the next poll, ~5s later — exactly the visible flash).
      setMessages((prev) => (
        prev.some((m) => m.message_id === msg.message_id) ? prev : [...prev, msg]
      ));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch { setText(trimmed); } finally { setSending(false); }
  };

  const title = type === 'dm' ? (name ?? 'Direct Message') : type === 'match' ? 'Match Chat' : 'Clan Chat';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={C.gold} size="large" /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.message_id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <MessageBubble msg={item} isMe={item.user_id === user?.user_id} />}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No messages yet.</Text>
              <Text style={styles.emptySub}>Say hello!</Text>
            </View>
          }
        />
      )}

      {/* Input */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message..."
          placeholderTextColor={C.textMuted}
          returnKeyType="send"
          onSubmitEditing={send}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]}
          onPress={send}
          disabled={!text.trim() || sending}
        >
          {sending
            ? <ActivityIndicator color="#000" size="small" />
            : <Text style={styles.sendBtnText}>Send</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ msg, isMe }: { msg: ChatMessage; isMe: boolean }) {
  const time = new Date(msg.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return (
    <View style={[styles.bubbleRow, isMe && styles.bubbleRowMe]}>
      {!isMe && (
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{msg.username[0].toUpperCase()}</Text>
        </View>
      )}
      <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
        {!isMe && <Text style={styles.bubbleName}>{msg.username}</Text>}
        <Text style={styles.bubbleBody}>{msg.body}</Text>
        <Text style={[styles.bubbleTime, isMe && { color: 'rgba(0,0,0,0.4)' }]}>{time}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: { width: 60 },
  backText: { color: C.gold, fontSize: 15, fontWeight: '600' },
  headerTitle: { color: C.text, fontSize: 16, fontWeight: '800' },

  listContent: { padding: 16, paddingBottom: 8, flexGrow: 1 },

  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 12, gap: 8 },
  bubbleRowMe: { flexDirection: 'row-reverse' },
  avatar: {
    width: 32, height: 32, borderRadius: 4, backgroundColor: C.gold + '33',
    justifyContent: 'center', alignItems: 'center', flexShrink: 0,
  },
  avatarText: { color: C.gold, fontWeight: '800', fontSize: 13 },
  bubble: {
    maxWidth: '75%', borderRadius: 6, padding: 10,
    borderWidth: 1,
  },
  bubbleMe: { backgroundColor: C.gold, borderColor: C.gold },
  bubbleThem: { backgroundColor: C.card, borderColor: C.border },
  bubbleName: { color: C.gold, fontSize: 11, fontWeight: '700', marginBottom: 3 },
  bubbleBody: { color: C.text, fontSize: 14, lineHeight: 20 },
  bubbleTime: { color: C.textDim, fontSize: 10, marginTop: 4, textAlign: 'right' },

  inputRow: {
    flexDirection: 'row', padding: 12, gap: 8,
    borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  input: {
    flex: 1, backgroundColor: C.card, color: C.text, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 14,
    borderWidth: 1, borderColor: C.border, maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: C.gold, borderRadius: 6, paddingHorizontal: 18,
    justifyContent: 'center', alignItems: 'center',
  },
  sendBtnText: { color: '#000', fontWeight: '800', fontSize: 14 },

  emptyText: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySub: { color: C.textMuted, fontSize: 13, marginTop: 6 },
});
