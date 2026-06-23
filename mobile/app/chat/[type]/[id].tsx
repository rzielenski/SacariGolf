import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  PanResponder, Animated, Image, Modal,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, API_BASE, subscribeConn } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { C, F } from '../../../lib/colors';
import { ChatMessage } from '../../../types';
import { VoiceMessageBubble } from '../../../components/VoiceMessageBubble';
import { UserAvatar } from '../../../components/UserAvatar';
import { IdentityName } from '../../../components/UserIdentity';
import { MentionInput } from '../../../components/MentionInput';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { censorText } from '../../../lib/censor';
import { Ionicons } from '@expo/vector-icons';
import { compressForUpload } from '../../../lib/imageUpload';

/** Horizontal distance the user has to drag the mic LEFT, in pixels, before
 *  the gesture is interpreted as "cancel this recording" instead of "send". */
const CANCEL_SLIDE_PX = 90;

/** Idempotency key for a single send attempt. The server has a partial
 *  unique index on (sender, client_id), so retrying with the same id can
 *  never duplicate the message — which makes retry-after-timeout safe. */
function genClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** AsyncStorage key holding this thread's unsent text messages, so a
 *  failed send survives leaving the screen or killing the app. */
const pendingKey = (type: string, id: string) => `sacari.chat.pending.v1.${type}.${id}`;

type PersistedPending = { client_id: string; body: string; created_at: string };

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { type, id, name } = useLocalSearchParams<{ type: 'match' | 'clan' | 'dm' | 'league'; id: string; name?: string }>();
  const { user } = useAuth();
  // Censor flag for the OUTER screen — used for the header title (DM
  // recipient's name). The MessageBubble component has its own
  // useCensor() call further down so bubble bodies / usernames are
  // censored independently.
  const censor = (user as any)?.censor_offensive_language !== false;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Chat participants — used as the @mention autocomplete source so you can
  // tag people who are actually IN this chat (incl. non-friend opponents).
  // DMs fall back to the friends list (only the one partner anyway).
  const [participants, setParticipants] = useState<{ user_id: string; username: string; avatar_url?: string | null }[]>([]);
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

  // Local bubbles that haven't been confirmed by the server yet, keyed by
  // client_id. The merged view = server rows + these, with any local whose
  // client_id shows up in a server row dropped (its send actually landed —
  // covers the "request succeeded but the response timed out" case, which
  // the next 5s poll heals automatically).
  const localsRef = useRef<Map<string, ChatMessage>>(new Map());

  const persistPendings = useCallback(() => {
    // Only text bubbles survive an app restart — media payloads are too
    // large to park in AsyncStorage, and re-picking a photo is cheap.
    const rows: PersistedPending[] = [];
    for (const m of localsRef.current.values()) {
      if (!m.voice_url && !m.image_url && m.body && m.client_id) {
        rows.push({ client_id: m.client_id, body: m.body, created_at: m.created_at });
      }
    }
    AsyncStorage.setItem(pendingKey(type!, id!), JSON.stringify(rows)).catch(() => { });
  }, [type, id]);

  const mergeServer = useCallback((server: ChatMessage[]) => {
    const locals = localsRef.current;
    let dropped = false;
    for (const m of server) {
      if (m.client_id && locals.has(m.client_id)) { locals.delete(m.client_id); dropped = true; }
    }
    if (dropped) persistPendings();
    return [...server, ...Array.from(locals.values())];
  }, [persistPendings]);

  const load = useCallback(async () => {
    try {
      const params = type === 'match' ? { matchId: id } : type === 'clan' ? { clanId: id } : type === 'league' ? { tournamentId: id } : { toUserId: id };
      const data = await api.messages.list(params);
      setMessages(mergeServer(data));
    } catch { /* silent */ } finally { setLoading(false); }
  }, [type, id, mergeServer]);

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

  /** POST one text message. On success the optimistic bubble is swapped
   *  for the server row; on failure it flips to 'failed' (tap to retry).
   *  Retries reuse the same clientId, so duplicates are impossible. */
  const postText = useCallback(async (clientId: string, bodyText: string) => {
    const params = type === 'match'
      ? { matchId: id, body: bodyText, clientId }
      : type === 'clan'
      ? { clanId: id, body: bodyText, clientId }
      : type === 'league'
      ? { tournamentId: id, body: bodyText, clientId }
      : { toUserId: id, body: bodyText, clientId };
    try {
      const msg = await api.messages.send(params);
      const server: ChatMessage = { ...msg, client_id: msg.client_id ?? clientId };
      localsRef.current.delete(clientId);
      persistPendings();
      setMessages((prev) => {
        const without = prev.filter((m) =>
          (m.client_id ?? m.message_id) !== clientId && m.message_id !== server.message_id);
        return [...without, server];
      });
    } catch (e: any) {
      // 4xx = the server understood and said no (not friends, not a
      // member...). Surface the reason — a retry without fixing the cause
      // will fail the same way. Network-class failures stay quiet: the
      // offline banner is already up and the bubble shows the retry state.
      const rejected = typeof e?.status === 'number' && e.status >= 400 && e.status < 500;
      const cur = localsRef.current.get(clientId);
      if (cur) {
        const failed: ChatMessage = {
          ...cur, _status: 'failed',
          _failReason: rejected ? (e?.message ?? 'Could not send') : undefined,
        };
        localsRef.current.set(clientId, failed);
        persistPendings();
        setMessages((prev) => prev.map((m) =>
          (m.client_id ?? m.message_id) === clientId ? failed : m));
      }
      if (rejected) Alert.alert('Could not send', e?.message ?? 'Try again.');
    }
  }, [type, id, persistPendings]);

  /** Flip a failed bubble back to 'sending' and re-POST it. */
  const retryLocal = useCallback((clientId: string) => {
    const cur = localsRef.current.get(clientId);
    if (!cur || !cur.body) return;
    const again: ChatMessage = { ...cur, _status: 'sending', _failReason: undefined };
    localsRef.current.set(clientId, again);
    setMessages((prev) => prev.map((m) =>
      (m.client_id ?? m.message_id) === clientId ? again : m));
    void postText(clientId, again.body);
  }, [postText]);

  /** Remove a failed local bubble (long-press → delete). */
  const discardLocal = useCallback((clientId: string) => {
    localsRef.current.delete(clientId);
    persistPendings();
    setMessages((prev) => prev.filter((m) => (m.client_id ?? m.message_id) !== clientId));
  }, [persistPendings]);

  // Restore unsent text messages from a previous session, then try them.
  // Re-posting an id that's already in flight is safe: the server's
  // client_id dedupe returns the original row.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(pendingKey(type!, id!));
        if (!raw || cancelled) return;
        const rows: PersistedPending[] = JSON.parse(raw);
        if (!Array.isArray(rows) || !rows.length) return;
        for (const r of rows) {
          if (localsRef.current.has(r.client_id)) continue;
          localsRef.current.set(r.client_id, {
            message_id: r.client_id, client_id: r.client_id,
            created_at: r.created_at, body: r.body,
            user_id: user?.user_id ?? '', username: user?.username ?? '',
            _status: 'sending',
          });
        }
        setMessages((prev) => mergeServer(prev.filter((m) => !m._status)));
        for (const r of rows) void postText(r.client_id, r.body);
      } catch { /* corrupted pending cache — ignore */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id, user?.user_id]);

  // When connectivity returns, auto-retry every failed text bubble rather
  // than waiting for the user to tap each one.
  useEffect(() => {
    const unsub = subscribeConn((state) => {
      if (state !== 'online') return;
      for (const [cid, m] of localsRef.current) {
        if (m._status === 'failed' && m.body && !m._failReason) retryLocal(cid);
      }
    });
    return unsub;
  }, [retryLocal]);

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length]);

  // Load this chat's roster for the @mention autocomplete (excluding self).
  useEffect(() => {
    let cancelled = false;
    const toPerson = (p: any) => ({ user_id: p.user_id, username: p.username, avatar_url: p.avatar_url });
    const apply = (rows: any[]) => {
      if (cancelled) return;
      setParticipants(
        rows.map(toPerson).filter((p) => p.user_id && p.username && p.user_id !== user?.user_id),
      );
    };
    if (type === 'match') {
      api.matches.get(id).then((m) => apply(m?.players ?? [])).catch(() => { });
    } else if (type === 'clan') {
      api.clans.get(id).then((c) => apply(c?.members ?? [])).catch(() => { });
    } else if (type === 'league') {
      api.tournaments.get(id).then((t) => apply(t?.players ?? [])).catch(() => { });
    } else {
      setParticipants([]); // DM → MentionInput falls back to friends
    }
    return () => { cancelled = true; };
  }, [type, id, user?.user_id]);

  const sendText = () => {
    const trimmed = text.trim();
    if (!trimmed || !user) return;
    setText('');
    // Optimistic: the bubble appears instantly in 'sending' state and the
    // POST happens behind it. The old flow held the whole composer hostage
    // on the network round-trip, and on a timeout the message just
    // vanished back into the input — the root of "my texts aren't
    // sending". Now the message is visibly in the thread with an explicit
    // sending / failed state, failures persist across app restarts, and
    // retries are idempotent server-side.
    const clientId = genClientId();
    const bubble: ChatMessage = {
      message_id: clientId,
      client_id: clientId,
      created_at: new Date().toISOString(),
      body: trimmed,
      user_id: user.user_id,
      username: user.username,
      avatar_url: (user as any)?.avatar_url ?? null,
      _status: 'sending',
    };
    localsRef.current.set(clientId, bubble);
    persistPendings();
    setMessages((prev) => [...prev, bubble]);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    void postText(clientId, trimmed);
  };

  /** Pick a photo from the library and send it as a chat message. Mirrors
   *  the voice flow: base64-encode → POST → optimistically append. */
  const sendImage = async () => {
    if (sending) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to send pictures.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.6,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    setSending(true);
    try {
      const img = await compressForUpload(asset);
      const base = type === 'match'
        ? { matchId: id }
        : type === 'clan'
        ? { clanId: id }
        : type === 'league'
        ? { tournamentId: id }
        : { toUserId: id };
      const msg = await api.messages.send({
        ...base,
        imageBase64: img.base64,
        imageMime: img.mime,
        clientId: genClientId(),
      });
      setMessages((prev) => (
        prev.some((m) => m.message_id === msg.message_id) ? prev : [...prev, msg]
      ));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e: any) {
      Alert.alert('Could not send photo', e?.message ?? 'Try again.');
    } finally {
      setSending(false);
    }
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
        : type === 'league'
        ? { tournamentId: id }
        : { toUserId: id };
      const msg = await api.messages.send({
        ...base,
        voiceBase64: clip.base64,
        voiceMime: clip.mime,
        voiceDurationMs: clip.durationMs,
        clientId: genClientId(),
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

  const title = type === 'dm' ? (name ? censorText(name, censor) : 'Direct Message')
    : type === 'match' ? 'Match Chat'
    : type === 'league' ? (name ? censorText(name, censor) : 'League Chat')
    : 'Team Chat';
  // Subtitle clarifies the audience. Easy to miss that match chat reaches
  // OPPONENTS too — team/clan chat is the teammates-only room. Making this
  // explicit avoids the "I thought my opponent couldn't see this" surprise.
  const subtitle = type === 'match'
    ? 'Everyone in this match'
    : type === 'clan'
    ? 'Your team only'
    : type === 'league'
    ? 'Everyone in this league'
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
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
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
              onRetry={item._status === 'failed' && item.client_id
                ? () => retryLocal(item.client_id!)
                : undefined}
              onDiscard={item._status === 'failed' && item.client_id
                ? () => discardLocal(item.client_id!)
                : undefined}
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
            <MentionInput
              style={styles.input}
              containerStyle={{ flex: 1 }}
              dropdownAbove
              people={type === 'dm' ? undefined : participants}
              value={text}
              onChangeText={setText}
              placeholder="Message… @ to tag"
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
            ) : (
              // Photo attach — only shown when there's no text to send
              // (where the Send button would otherwise sit), so the
              // composer stays uncluttered.
              <TouchableOpacity
                style={[styles.imgBtn, sending && { opacity: 0.4 }]}
                onPress={sendImage}
                disabled={sending}
              >
                <Ionicons name="image-outline" size={22} color={C.text} />
              </TouchableOpacity>
            )}
          </>
        )}
        {/* Mic always present so the gesture target doesn't disappear when
            the user starts typing. While recording, the button visually
            transforms into a stop-the-record receptacle. */}
        <View
          style={[styles.micBtn, recording && styles.micBtnActive]}
          {...micPan.panHandlers}
        >
          <Ionicons name={recording ? 'stop' : 'mic-outline'} size={recording ? 20 : 22} color={recording ? '#fff' : C.text} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ msg, isMe, onReport, onRetry, onDiscard }: {
  msg: ChatMessage; isMe: boolean; onReport: () => void;
  onRetry?: () => void; onDiscard?: () => void;
}) {
  // Censor is opt-out (default ON). The viewer's preference governs what
  // THEY see — senders aren't policed; readers control their own surface.
  const { user } = useAuth();
  const censor = user?.censor_offensive_language !== false;
  const [zoom, setZoom] = useState(false);
  const time = new Date(msg.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const isSending = msg._status === 'sending';
  const isFailed = msg._status === 'failed';
  const imageUri = msg.image_url
    ? (msg.image_url.startsWith('http') ? msg.image_url : `${API_BASE}${msg.image_url}`)
    : null;
  // Whether the body is just the auto-generated photo/voice placeholder —
  // if so we don't render it as a text line (the media itself is the content).
  const isPlaceholderBody = msg.body === '📷 Photo' || msg.body === '🎤 Voice message';

  // Tap → retry a failed send. Long-press → report (others) or discard a
  // failed local bubble (own). Disabled otherwise.
  return (
    <TouchableOpacity
      style={[styles.bubbleRow, isMe && styles.bubbleRowMe, isSending && { opacity: 0.65 }]}
      onPress={onRetry}
      onLongPress={
        isMe
          ? (isFailed && onDiscard
              ? () => Alert.alert('Unsent message', undefined, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: onDiscard },
                ])
              : undefined)
          : onReport
      }
      activeOpacity={isFailed ? 0.7 : 1}
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
      <View style={[
        styles.bubble,
        isMe ? styles.bubbleMe : styles.bubbleThem,
        isFailed && styles.bubbleFailed,
      ]}>
        {!isMe && (
          <IdentityName visual={(msg as any).equipped_visual} style={styles.bubbleName}>
            {censorText(msg.username, censor)}
          </IdentityName>
        )}
        {msg.voice_url ? (
          <VoiceMessageBubble
            url={msg.voice_url}
            durationMs={msg.voice_duration_ms ?? null}
            tint={isMe ? 'self' : 'other'}
          />
        ) : imageUri ? (
          <>
            <TouchableOpacity onPress={() => setZoom(true)} activeOpacity={0.9}>
              <Image source={{ uri: imageUri }} style={styles.bubbleImage} resizeMode="cover" />
            </TouchableOpacity>
            {/* A caption only renders if the sender typed real text (not the
                "📷 Photo" placeholder body the server stores). */}
            {!isPlaceholderBody && msg.body ? (
              <Text style={[styles.bubbleBody, isMe && { color: '#000' }, { marginTop: 6 }]}>
                {censorText(msg.body, censor)}
              </Text>
            ) : null}
            {/* Full-screen tap-to-zoom viewer. */}
            <Modal visible={zoom} transparent animationType="fade" onRequestClose={() => setZoom(false)}>
              <TouchableOpacity style={styles.zoomBackdrop} activeOpacity={1} onPress={() => setZoom(false)}>
                <Image source={{ uri: imageUri }} style={styles.zoomImage} resizeMode="contain" />
              </TouchableOpacity>
            </Modal>
          </>
        ) : (
          <Text style={[styles.bubbleBody, isMe && { color: '#000' }]}>{censorText(msg.body, censor)}</Text>
        )}
        {isSending ? (
          <Text style={[styles.bubbleTime, isMe && { color: 'rgba(0,0,0,0.4)' }]}>Sending…</Text>
        ) : isFailed ? (
          <Text style={styles.bubbleFailedText}>
            {msg._failReason ? `${msg._failReason} · tap to retry` : 'Not sent · tap to retry'}
          </Text>
        ) : (
          <Text style={[styles.bubbleTime, isMe && { color: 'rgba(0,0,0,0.4)' }]}>{time}</Text>
        )}
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
  bubbleFailed: { borderColor: C.red, borderWidth: 1.5 },
  bubbleFailedText: { color: C.red, fontSize: 10, marginTop: 4, textAlign: 'right', fontWeight: '700' },
  bubbleName: { color: C.gold, fontSize: 11, fontWeight: '700', marginBottom: 3 },
  bubbleBody: { color: C.text, fontSize: 14, lineHeight: 20 },
  bubbleTime: { color: C.textDim, fontSize: 10, marginTop: 4, textAlign: 'right' },
  // Inline image preview in a chat bubble — fixed footprint, cover-cropped.
  // Tapping opens the full-screen zoom modal.
  bubbleImage: { width: 200, height: 200, borderRadius: 8, backgroundColor: C.bg },
  zoomBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  zoomImage: { width: '100%', height: '100%' },

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

  // Photo-attach button — same footprint as mic/send for a tidy composer.
  imgBtn: {
    width: 44, height: 40, borderRadius: 6,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    justifyContent: 'center', alignItems: 'center',
  },
  imgGlyph: { fontSize: 18 },

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
