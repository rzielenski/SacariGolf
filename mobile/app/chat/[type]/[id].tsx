import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  PanResponder, Animated,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { C, F } from '../../../lib/colors';
import { ChatMessage } from '../../../types';
import { VoiceMessageBubble } from '../../../components/VoiceMessageBubble';
import { UserAvatar } from '../../../components/UserAvatar';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { censorText } from '../../../lib/censor';

/** Horizontal distance the user has to drag the mic LEFT, in pixels, before
 *  the gesture is interpreted as "cancel this recording" instead of "send". */
const CANCEL_SLIDE_PX = 90;

export default function ChatScreen() {
  const { type, id, name } = useLocalSearchParams<{ type: 'match' | 'clan' | 'dm'; id: string; name?: string }>();
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Voice-message recorder + slide-to-cancel state
  const recorder = useVoiceRecorder(60_000);
  // dragX: signed offset of the user's finger from the mic button while
  // recording. Negative = pulled left toward the cancel zone. Drives the
  // mic-row's visual offset + the cancel hint opacity.
  const dragX = useRef(new Animated.Value(0)).current;
  // Latched cancel flag — once the user crosses CANCEL_SLIDE_PX we lock
  // in the cancel intent so a brief drag-back-right doesn't re-arm send.
  const cancelLatched = useRef(false);

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
    const markRead = () => {
      if (!type || !id) return;
      api.messages.markRead(type, id).catch(() => { });
    };
    markRead();
    const readInterval = setInterval(markRead, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(readInterval);
      markRead();
    };
  }, [load, type, id]);

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length]);

  const sendText = async () => {
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
      setMessages((prev) => (
        prev.some((m) => m.message_id === msg.message_id) ? prev : [...prev, msg]
      ));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch { setText(trimmed); } finally { setSending(false); }
  };

  /** Finalise the recording and POST it. Called by the PanResponder's
   *  release handler when cancelLatched is false. */
  const sendVoice = async () => {
    const clip = await recorder.stopAndGet();
    if (!clip) return;          // permission denied / start failed / no audio
    if (clip.durationMs < 500) return;   // sub-half-second = accidental tap
    setSending(true);
    try {
      const base = type === 'match'
        ? { matchId: id }
        : type === 'clan'
        ? { clanId: id }
        : { toUserId: id };
      const msg = await api.messages.send({
        ...base,
        voiceBase64: clip.base64,
        voiceMime: clip.mime,
        voiceDurationMs: clip.durationMs,
      });
      setMessages((prev) => (
        prev.some((m) => m.message_id === msg.message_id) ? prev : [...prev, msg]
      ));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e: any) {
      Alert.alert('Could not send voice message', e?.message ?? 'Try again.');
    } finally {
      setSending(false);
    }
  };

  // PanResponder on the mic button. onStartShouldSet captures the touch
  // immediately; onMove drives the slide-to-cancel affordance; onRelease
  // dispatches to sendVoice or cancel depending on the latched intent.
  const micPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: async () => {
      cancelLatched.current = false;
      dragX.setValue(0);
      const ok = await recorder.start();
      if (!ok) {
        Alert.alert(
          'Microphone Permission',
          'Enable mic access in Settings to send voice messages.',
        );
      }
    },
    onPanResponderMove: (_, g) => {
      // Clamp dragX to [-150, 0] — pulling right past the mic does nothing.
      const x = Math.max(-150, Math.min(0, g.dx));
      dragX.setValue(x);
      if (x <= -CANCEL_SLIDE_PX) cancelLatched.current = true;
    },
    onPanResponderRelease: () => {
      Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
      if (cancelLatched.current) {
        recorder.cancel();
      } else {
        sendVoice();
      }
    },
    onPanResponderTerminate: () => {
      // Gesture stolen (e.g. scroll). Treat as cancel rather than send.
      Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
      recorder.cancel();
    },
  // recorder is stable across renders (own state); dragX is a ref; ok to
  // bind once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })).current;

  const title = type === 'dm' ? (name ?? 'Direct Message') : type === 'match' ? 'Match Chat' : 'Team Chat';
  // Subtitle clarifies the audience. Easy to miss that match chat reaches
  // OPPONENTS too — team/clan chat is the teammates-only room. Making this
  // explicit avoids the "I thought my opponent couldn't see this" surprise.
  const subtitle = type === 'match'
    ? 'Everyone in this match'
    : type === 'clan'
    ? 'Your team only'
    : null;

  const reportMessage = (msg: ChatMessage) => {
    if (msg.user_id === user?.user_id) return; // can't report your own
    Alert.prompt?.(
      'Report message',
      `Why are you reporting ${msg.username}'s message?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: async (reason?: string) => {
            try {
              await api.messages.report(
                type === 'dm' ? 'dm' : 'channel',
                msg.message_id,
                reason ?? undefined,
              );
              Alert.alert('Thanks', 'A moderator will review this message.');
            } catch (e: any) {
              Alert.alert('Could not submit report', e?.message ?? 'Try again.');
            }
          },
        },
      ],
      'plain-text',
    );
    // Android fallback — Alert.prompt is iOS-only. Send a no-reason report.
    if (Platform.OS !== 'ios') {
      Alert.alert(
        'Report this message?',
        `${msg.username}'s message will be sent to moderators for review.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report', style: 'destructive',
            onPress: async () => {
              try {
                await api.messages.report(
                  type === 'dm' ? 'dm' : 'channel',
                  msg.message_id,
                );
                Alert.alert('Thanks', 'A moderator will review this message.');
              } catch (e: any) {
                Alert.alert('Could not submit report', e?.message ?? 'Try again.');
              }
            },
          },
        ],
      );
    }
  };

  const recording = recorder.recording;
  const elapsedSec = Math.floor(recorder.elapsedMs / 1000);
  const elapsedDisplay = `${Math.floor(elapsedSec / 60)}:${(elapsedSec % 60).toString().padStart(2, '0')}`;

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
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>{title}</Text>
          {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
        </View>
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
          renderItem={({ item }) => (
            <MessageBubble
              msg={item}
              isMe={item.user_id === user?.user_id}
              onReport={() => reportMessage(item)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No messages yet.</Text>
              <Text style={styles.emptySub}>Say hello!</Text>
            </View>
          }
          // Keep taps on message rows (e.g. long-press → Report) working even
          // when the input keyboard is open. Default RN behaviour dismisses
          // the keyboard on first tap and swallows the second; "handled" lets
          // child Touchables fire first, dragging the list still dismisses.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // Auto-scroll to the latest message when the layout changes —
          // covers the case where the keyboard opens and shrinks the list
          // viewport (without this, the most recent message gets pushed
          // behind the keyboard until the next manual scroll).
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      {/* Input row — collapses to a recording indicator while the user holds
          the mic. The text input + send button are replaced by an animated
          slide-to-cancel affordance so a single tap target serves both UIs. */}
      <View style={styles.inputRow}>
        {recording ? (
          <Animated.View style={[styles.recordingBar, { transform: [{ translateX: dragX }] }]}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime}>{elapsedDisplay}</Text>
            <Text style={styles.recordingHint}>← slide to cancel</Text>
          </Animated.View>
        ) : (
          <>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Message..."
              placeholderTextColor={C.textMuted}
              returnKeyType="send"
              onSubmitEditing={sendText}
              multiline
            />
            {text.trim().length > 0 ? (
              <TouchableOpacity
                style={[styles.sendBtn, sending && { opacity: 0.4 }]}
                onPress={sendText}
                disabled={sending}
              >
                {sending
                  ? <ActivityIndicator color="#000" size="small" />
                  : <Text style={styles.sendBtnText}>Send</Text>}
              </TouchableOpacity>
            ) : null}
          </>
        )}
        {/* Mic always present so the gesture target doesn't disappear when
            the user starts typing. While recording, the button visually
            transforms into a stop-the-record receptacle. */}
        <View
          style={[styles.micBtn, recording && styles.micBtnActive]}
          {...micPan.panHandlers}
        >
          <Text style={styles.micGlyph}>{recording ? '■' : '🎤'}</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ msg, isMe, onReport }: {
  msg: ChatMessage; isMe: boolean; onReport: () => void;
}) {
  // Censor is opt-out (default ON). The viewer's preference governs what
  // THEY see — senders aren't policed; readers control their own surface.
  const { user } = useAuth();
  const censor = user?.censor_offensive_language !== false;
  const time = new Date(msg.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  // Long-press → report. Disabled for own messages (no point reporting self).
  return (
    <TouchableOpacity
      style={[styles.bubbleRow, isMe && styles.bubbleRowMe]}
      onLongPress={isMe ? undefined : onReport}
      activeOpacity={1}
      delayLongPress={400}
    >
      {!isMe && (
        <UserAvatar
          username={msg.username}
          avatarUrl={msg.avatar_url}
          size={32}
          borderRadius={4}
          style={{ flexShrink: 0 }}
        />
      )}
      <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
        {!isMe && <Text style={styles.bubbleName}>{msg.username}</Text>}
        {msg.voice_url ? (
          <VoiceMessageBubble
            url={msg.voice_url}
            durationMs={msg.voice_duration_ms ?? null}
            tint={isMe ? 'self' : 'other'}
          />
        ) : (
          <Text style={[styles.bubbleBody, isMe && { color: '#000' }]}>{censorText(msg.body, censor)}</Text>
        )}
        <Text style={[styles.bubbleTime, isMe && { color: 'rgba(0,0,0,0.4)' }]}>{time}</Text>
      </View>
    </TouchableOpacity>
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
  headerTitleWrap: { alignItems: 'center', flex: 1 },
  headerTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
  headerSubtitle: { color: C.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2, letterSpacing: 0.5 },

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
    flexDirection: 'row', padding: 12, gap: 8, alignItems: 'center',
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
    justifyContent: 'center', alignItems: 'center', height: 40,
  },
  sendBtnText: { color: '#000', fontWeight: '800', fontSize: 14 },

  // Mic button — same footprint as send so the gesture target is consistent.
  micBtn: {
    width: 44, height: 40, borderRadius: 6,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    justifyContent: 'center', alignItems: 'center',
  },
  micBtnActive: { backgroundColor: C.red, borderColor: C.red },
  micGlyph: { fontSize: 18 },

  // Recording-in-progress UI — replaces the text input + send button while
  // the user is holding the mic.
  recordingBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderWidth: 1, borderColor: C.red + '88',
    borderRadius: 6, paddingHorizontal: 14, height: 40, gap: 10,
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: C.red,
  },
  recordingTime: { color: C.text, fontFamily: F.serif, fontWeight: '800', fontSize: 14 },
  recordingHint: { color: C.textMuted, fontSize: 11, flex: 1, textAlign: 'right' },

  emptyText: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySub: { color: C.textMuted, fontSize: 13, marginTop: 6 },
});
