/**
 * Shared social-feed surface. Used by the home tab as the bottom of the
 * scroll (with the user's stats + nav shortcuts passed in as
 * `headerComponent`) and previously by the social tab.
 *
 * Three card kinds:
 *   • 'round' — auto-posted on match completion; pulls course + score from
 *               the joined match row server-side and renders a result card
 *   • 'text'  — just the author's typed body
 *   • 'photo' — image + optional caption
 *
 * Posts surfaced from friends-of-friends (server marks `is_fof`) get a tiny
 * "via a friend" attribution so users can tell why a stranger shows up.
 *
 * A Global / Local / Friends toggle at the top of the feed switches the
 * audience (see api.posts.feed): everyone, players whose home course is
 * near you, or accepted friends only.
 *
 * Designed to be the ONLY scrollable surface on the screen it's placed in —
 * a `headerComponent` slot stitches arbitrary content above the feed items
 * so the whole tab scrolls as one. Don't nest this inside a ScrollView.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  FlatList, RefreshControl, Image, Modal, TextInput, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { api, API_BASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { censorText } from '../lib/censor';

interface Props {
  /** Anything that should render above the feed items inside the same
   *  FlatList — typically the home tab's stats + nav shortcuts. */
  headerComponent?: React.ReactElement | null;
  /** Optional callback run alongside the feed reload when the user pulls
   *  to refresh. Use this to refresh stats / banners that live in the
   *  header. */
  onRefreshExtra?: () => Promise<void> | void;
}

/** Feed audience. Mirrors the backend `?scope=` param on GET /posts/feed. */
type FeedScope = 'global' | 'local' | 'friends';
const SCOPES: { key: FeedScope; label: string }[] = [
  { key: 'global', label: 'Global' },
  { key: 'local', label: 'Local' },
  { key: 'friends', label: 'Friends' },
];

export function SocialFeed({ headerComponent, onRefreshExtra }: Props) {
  const { user } = useAuth();
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  // Feed audience toggle — see api.posts.feed. 'global' is the default so a
  // brand-new user with no friends still lands on a populated feed.
  const [scope, setScope] = useState<FeedScope>('global');
  // Set when scope==='local' but the server had no home course / GPS to
  // anchor on — drives a tailored "set a home course" empty state.
  const [localUnavailable, setLocalUnavailable] = useState(false);
  // When the feed fetch errors we keep `loading`/`posts` honest but stash
  // the message so the empty-state can say "Couldn't reach the feed" instead
  // of the generic "No posts yet". Pull-to-refresh clears it.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      // Run the optional caller-supplied refresh (e.g. refreshUser for
      // the home tab) in parallel with the feed fetch so a single pull
      // updates everything in one round-trip wait.
      const [res] = await Promise.all([
        api.posts.feed({ limit: 30, scope }),
        isRefresh && onRefreshExtra ? Promise.resolve(onRefreshExtra()) : Promise.resolve(),
      ]);
      setPosts(res.posts ?? []);
      setLocalUnavailable(!!res.localUnavailable);
      setError(null);
    } catch (e: any) {
      // Distinguish "endpoint unreachable / 404" from "empty result" so the
      // empty-state isn't ambiguous when the backend deploy hasn't caught
      // up yet. The OfflineError sentinel from api.ts indicates network-
      // class failure; anything else is a real server response.
      setError(friendlyError(e));
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [onRefreshExtra, scope]);

  useEffect(() => { load(); }, [load]);

  /** Switch the feed audience. Clears the list immediately so the user sees
   *  a spinner rather than stale posts from the previous scope while the new
   *  fetch is in flight (the `load` effect re-fires because `scope` changed). */
  const switchScope = (next: FeedScope) => {
    if (next === scope) return;
    setScope(next);
    setPosts([]);
    setLoading(true);
    setError(null);
  };

  const handleDelete = (postId: string) => {
    Alert.alert(
      'Delete post?',
      'This removes the post from your feed and your friends\' feeds.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            // Optimistic remove — rolls back on error.
            const prev = posts;
            setPosts((p) => p.filter((x) => x.post_id !== postId));
            try { await api.posts.delete(postId); }
            catch (e: any) {
              Alert.alert('Could not delete', e?.message ?? 'Try again.');
              setPosts(prev);
            }
          },
        },
      ],
    );
  };

  /** Report another user's post. iOS gets an optional free-text reason via
   *  Alert.prompt; Android falls back to a plain confirm (Alert.prompt is
   *  iOS-only). Required for App Store UGC compliance — every user-content
   *  surface needs a report path. */
  const handleReport = (postId: string) => {
    const submit = async (reason?: string) => {
      try {
        await api.posts.report(postId, reason);
        Alert.alert('Thanks', 'A moderator will review this post.');
      } catch (e: any) {
        Alert.alert('Could not submit report', e?.message ?? 'Try again.');
      }
    };
    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        'Report post',
        'Why are you reporting this post? (optional)',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Report', style: 'destructive', onPress: (reason?: string) => submit(reason) },
        ],
        'plain-text',
      );
    } else {
      Alert.alert(
        'Report this post?',
        'It will be sent to moderators for review.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Report', style: 'destructive', onPress: () => submit() },
        ],
      );
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={posts}
        keyExtractor={(p) => p.post_id}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          <>
            {headerComponent}
            <View style={s.scopeBar}>
              {SCOPES.map((sc) => {
                const active = sc.key === scope;
                return (
                  <TouchableOpacity
                    key={sc.key}
                    style={[s.scopeTab, active && s.scopeTabActive]}
                    onPress={() => switchScope(sc.key)}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.scopeTabText, active && s.scopeTabTextActive]}>
                      {sc.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.gold} />
        }
        renderItem={({ item }) => (
          <PostCard
            post={item}
            isOwn={item.user_id === user?.user_id}
            onDelete={() => handleDelete(item.post_id)}
            onReport={() => handleReport(item.post_id)}
          />
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
          ) : error ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={s.empty}>Couldn't load feed</Text>
              <Text style={s.emptySub}>{error}</Text>
              <Text style={[s.emptySub, { marginTop: 8 }]}>Pull down to retry.</Text>
            </View>
          ) : scope === 'local' && localUnavailable ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={s.empty}>No location set</Text>
              <Text style={s.emptySub}>
                Set a home course in your profile to see posts from players near you.
              </Text>
            </View>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={s.empty}>
                {scope === 'friends'
                  ? 'No posts from friends yet.'
                  : scope === 'local'
                    ? 'No posts from players near you yet.'
                    : 'No posts yet.'}
              </Text>
              <Text style={s.emptySub}>
                {scope === 'friends'
                  ? 'Add friends or tap "+ Post" to get the feed going.'
                  : 'Play a round or tap "+ Post" to start the feed.'}
              </Text>
            </View>
          )
        }
      />

      {/* Floating compose button — bottom-right above the tab bar */}
      <TouchableOpacity
        style={s.composeFab}
        onPress={() => setComposeOpen(true)}
        activeOpacity={0.8}
      >
        <Text style={s.composeFabText}>+ Post</Text>
      </TouchableOpacity>

      <ComposeModal
        visible={composeOpen}
        onClose={() => setComposeOpen(false)}
        onPosted={(newPost) => {
          // Prepend so the user sees their post at the top immediately.
          setPosts((p) => [newPost, ...p]);
          setComposeOpen(false);
        }}
      />
    </View>
  );
}

/** One post card. Branches on kind. Long-press a post that isn't yours to
 *  report it (App Store UGC requirement — every content surface needs a
 *  report path). Own posts long-press / tap the × to delete. */
function PostCard({ post, isOwn, onDelete, onReport }: {
  post: any; isOwn: boolean; onDelete: () => void; onReport: () => void;
}) {
  const { user } = useAuth();
  // Default ON: the censor is opt-OUT. If the user record hasn't loaded
  // yet (anon home tab) we still censor — fail safe.
  const censor = user?.censor_offensive_language !== false;
  // Comment thread state lives on the card so the count badge updates
  // live after you add/delete without re-fetching the whole feed.
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState<number>(post.comment_count ?? 0);
  const when = relativeTime(post.created_at);
  const authorAvatar = post.author_avatar
    ? (post.author_avatar.startsWith('http') ? post.author_avatar : `${API_BASE}${post.author_avatar}`)
    : null;
  return (
    <TouchableOpacity
      style={s.card}
      activeOpacity={1}
      // Long-press is the discoverable gesture for moderation on a content
      // card. Own posts → delete; others' posts → report.
      onLongPress={isOwn ? onDelete : onReport}
      delayLongPress={400}
    >
      <View style={s.cardHeader}>
        <TouchableOpacity
          style={s.headerLeft}
          onPress={() => router.push(`/user/${post.user_id}` as any)}
          activeOpacity={0.7}
        >
          {authorAvatar
            ? <Image source={{ uri: authorAvatar }} style={s.avatar} />
            : (
              <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarFallbackText}>
                  {(censorText(post.author_username ?? '?', censor))[0]?.toUpperCase()}
                </Text>
              </View>
            )}
          <View style={{ flex: 1 }}>
            <Text style={s.authorName}>{post.author_username ? censorText(post.author_username, censor) : 'Unknown'}</Text>
            <Text style={s.timestamp}>
              {when}
              {post.is_fof && <Text style={s.fof}> · via a friend</Text>}
            </Text>
          </View>
        </TouchableOpacity>
        {isOwn ? (
          <TouchableOpacity onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.deleteX}>×</Text>
          </TouchableOpacity>
        ) : (
          // Explicit, always-visible report affordance — long-press is the
          // primary path but Apple reviewers (and users) expect a tappable
          // control too, not a hidden gesture.
          <TouchableOpacity onPress={onReport} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={s.reportFlag}>⚑</Text>
          </TouchableOpacity>
        )}
      </View>

      {post.kind === 'round' && <RoundCardBody post={post} />}
      {post.kind === 'text' && post.body && (
        <Text style={s.bodyText}>{censorText(post.body, censor)}</Text>
      )}
      {post.kind === 'photo' && (
        <>
          {post.image_url && (
            <Image
              source={{ uri: post.image_url.startsWith('http') ? post.image_url : `${API_BASE}${post.image_url}` }}
              style={s.photo}
              resizeMode="cover"
            />
          )}
          {post.body && <Text style={s.caption}>{censorText(post.body, censor)}</Text>}
        </>
      )}

      {/* Comment bar — opens the thread for ANY post (yours or others').
          Shows a live count once there are comments. */}
      <TouchableOpacity
        style={s.commentBar}
        onPress={() => setCommentsOpen(true)}
        activeOpacity={0.7}
      >
        <Text style={s.commentBarText}>
          💬 {commentCount > 0
            ? `${commentCount} comment${commentCount === 1 ? '' : 's'}`
            : 'Comment'}
        </Text>
      </TouchableOpacity>

      <CommentsModal
        visible={commentsOpen}
        postId={post.post_id}
        censor={censor}
        onClose={() => setCommentsOpen(false)}
        onCountChange={setCommentCount}
      />
    </TouchableOpacity>
  );
}

/** Comments thread for one post — bottom sheet with the list + a composer.
 *  Mirrors the round-comments UX in the scorecard modal. Loads on open,
 *  optimistic-ish (refetches after each mutation), and reports the new
 *  count back up so the card's badge stays in sync. */
function CommentsModal({
  visible, postId, censor, onClose, onCountChange,
}: {
  visible: boolean;
  postId: string;
  censor: boolean;
  onClose: () => void;
  onCountChange: (n: number) => void;
}) {
  const [comments, setComments] = useState<any[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api.posts.comments(postId);
      setComments(rows);
      onCountChange(rows.length);
    } catch {
      setComments([]);
    }
  }, [postId, onCountChange]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.posts.addComment(postId, body);
      setDraft('');
      await load();
    } catch (e: any) {
      Alert.alert('Could not comment', e?.message ?? 'Try again.');
    } finally {
      setSending(false);
    }
  };

  const remove = (commentId: string) => {
    Alert.alert('Delete comment?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await api.posts.deleteComment(postId, commentId);
            await load();
          } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again.'); }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.composeHeader}>
          <TouchableOpacity onPress={onClose}>
            <Text style={s.composeCancel}>Close</Text>
          </TouchableOpacity>
          <Text style={s.composeTitle}>Comments</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          {comments === null ? (
            <ActivityIndicator color={C.gold} style={{ marginTop: 24 }} />
          ) : comments.length === 0 ? (
            <Text style={s.commentsEmpty}>No comments yet — be the first.</Text>
          ) : (
            comments.map((cm) => (
              <View key={cm.comment_id} style={s.commentRow}>
                <TouchableOpacity onPress={() => router.push(`/user/${cm.user_id}` as any)}>
                  {cm.avatar_url ? (
                    <Image
                      source={{ uri: cm.avatar_url.startsWith('http') ? cm.avatar_url : `${API_BASE}${cm.avatar_url}` }}
                      style={s.commentAvatar}
                    />
                  ) : (
                    <View style={[s.commentAvatar, s.avatarFallback]}>
                      <Text style={s.avatarFallbackText}>{censorText(cm.username ?? '?', censor)[0]?.toUpperCase()}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  <Text style={s.commentAuthor}>{censorText(cm.username, censor)}</Text>
                  <Text style={s.commentBody}>{censorText(cm.body, censor)}</Text>
                  <Text style={s.commentTime}>{relativeTime(cm.created_at)}</Text>
                </View>
                {cm.mine && (
                  <TouchableOpacity onPress={() => remove(cm.comment_id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={s.deleteX}>×</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </ScrollView>

        <View style={s.commentComposer}>
          <TextInput
            style={s.commentInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a comment…"
            placeholderTextColor={C.textMuted}
            maxLength={280}
            multiline
          />
          <TouchableOpacity
            style={[s.commentSendBtn, (!draft.trim() || sending) && { opacity: 0.4 }]}
            onPress={submit}
            disabled={!draft.trim() || sending}
            activeOpacity={0.7}
          >
            {sending
              ? <ActivityIndicator color={C.bg} size="small" />
              : <Text style={s.commentSendText}>Post</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Round card body — pulls from the server-joined match fields. */
function RoundCardBody({ post }: { post: any }) {
  const strokes = post.author_strokes;
  // Pro-rate par to the number of holes actually played. Previously this
  // used `teebox_par` raw, which is always the FULL teebox par (18-hole
  // par on most teeboxes). A 9-hole round of an 18-hole teebox would
  // then read "−31" or similar nonsense. Pro-rating by hole-count gets
  // us the right answer on every standard layout (front 9 ≈ back 9
  // par; the tiny asymmetry on courses like Lake Pleasant red — 37/36
  // — is within rounding tolerance for a feed card).
  const teeboxPar       = typeof post.teebox_par       === 'number' ? post.teebox_par       : null;
  const teeboxNumHoles  = typeof post.teebox_num_holes === 'number' ? post.teebox_num_holes : null;
  const matchNumHoles   = typeof post.match_num_holes  === 'number' ? post.match_num_holes  : null;
  let par: number | null = teeboxPar;
  if (teeboxPar != null && teeboxNumHoles && matchNumHoles && matchNumHoles !== teeboxNumHoles) {
    par = Math.round(teeboxPar * (matchNumHoles / teeboxNumHoles));
  }
  const overUnder = (typeof strokes === 'number' && typeof par === 'number')
    ? strokes - par : null;
  const ouLabel = overUnder == null
    ? null
    : overUnder === 0 ? 'E' : overUnder > 0 ? `+${overUnder}` : `${overUnder}`;
  const ouColor = overUnder == null
    ? C.text
    : overUnder < 0 ? C.green : overUnder === 0 ? C.text : '#FF9800';
  // Holes-played suffix shows on the course line so the viewer always
  // knows whether they're looking at a 9 or 18-hole result. Avoids a
  // future "this looks too good" reaction to a 9-hole score next to an
  // 18-hole one.
  const holesSuffix = matchNumHoles ? ` · ${matchNumHoles} holes` : '';

  const wonByMe =
    typeof post.winner_side === 'number'
      && typeof post.author_side === 'number'
      && post.winner_side === post.author_side;
  const tied = post.match_completed && post.winner_side == null;

  return (
    <TouchableOpacity
      style={s.roundBody}
      onPress={() => post.match_id && router.push(`/match/${post.match_id}` as any)}
      activeOpacity={0.85}
    >
      <Text style={s.roundCourse}>
        {post.course_name ?? 'A course'} · {post.teebox_name ?? '—'}{holesSuffix}
      </Text>
      <View style={s.roundScoreRow}>
        <Text style={[s.roundScore, { color: ouColor }]}>
          {typeof strokes === 'number' ? strokes : '—'}
        </Text>
        {ouLabel && (
          <Text style={[s.roundDelta, { color: ouColor }]}>{ouLabel}</Text>
        )}
        <View style={{ flex: 1 }} />
        {post.match_completed && (
          <View style={[
            s.resultBadge,
            wonByMe ? s.resultWin : tied ? s.resultTie : s.resultLoss,
          ]}>
            <Text style={[
              s.resultText,
              wonByMe ? { color: C.green } : tied ? { color: C.text } : { color: '#FF6B6B' },
            ]}>
              {wonByMe ? 'WIN' : tied ? 'TIE' : 'LOSS'}
            </Text>
          </View>
        )}
      </View>
      <Text style={s.roundMeta}>
        {post.match_type ? post.match_type.toUpperCase() : 'MATCH'}
        {post.format && post.format !== 'stroke' ? ` · ${post.format}` : ''}
        {typeof post.delta_elo === 'number' && post.match_completed
          ? ` · ${wonByMe ? '+' : tied ? '±' : '−'}${post.delta_elo} ELO`
          : ''}
      </Text>
    </TouchableOpacity>
  );
}

/** Compose modal — text body + optional image. */
function ComposeModal({
  visible, onClose, onPosted,
}: {
  visible: boolean;
  onClose: () => void;
  onPosted: (post: any) => void;
}) {
  const [body, setBody] = useState('');
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string | null>(null);
  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  // Reset drafts each time the modal opens so a cancelled draft doesn't
  // resurrect on the next compose.
  useEffect(() => {
    if (visible) {
      setBody(''); setImageBase64(null); setImageMime(null);
      setImagePreviewUri(null); setPosting(false);
    }
  }, [visible]);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.75,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    setImageBase64(asset.base64!);
    setImageMime(asset.mimeType ?? 'image/jpeg');
    setImagePreviewUri(asset.uri);
  };

  const submit = async () => {
    const text = body.trim();
    if (!text && !imageBase64) {
      Alert.alert('Empty post', 'Add some text or pick a photo.');
      return;
    }
    setPosting(true);
    try {
      const post = await api.posts.create({
        body: text || undefined,
        imageBase64: imageBase64 || undefined,
        imageMime: imageMime || undefined,
      });
      onPosted(post);
    } catch (e: any) {
      Alert.alert('Could not post', e?.message ?? 'Try again.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.composeHeader}>
          <TouchableOpacity onPress={onClose}>
            <Text style={s.composeCancel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.composeTitle}>New Post</Text>
          <TouchableOpacity
            onPress={submit}
            disabled={posting || (!body.trim() && !imageBase64)}
          >
            <Text style={[
              s.composePost,
              (posting || (!body.trim() && !imageBase64)) && { opacity: 0.4 },
            ]}>
              {posting ? '…' : 'Post'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
          <TextInput
            style={s.composeInput}
            value={body}
            onChangeText={setBody}
            placeholder="What's going on? Share a tip, a win, a wild miss…"
            placeholderTextColor={C.textMuted}
            multiline
            maxLength={1000}
          />
          <Text style={s.charCount}>{body.length}/1000</Text>

          {imagePreviewUri ? (
            <View style={s.composeImageWrap}>
              <Image source={{ uri: imagePreviewUri }} style={s.composeImage} resizeMode="cover" />
              <TouchableOpacity
                style={s.composeImageRemove}
                onPress={() => { setImageBase64(null); setImageMime(null); setImagePreviewUri(null); }}
              >
                <Text style={s.composeImageRemoveText}>×</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={s.composePickBtn} onPress={pickImage} activeOpacity={0.7}>
              <Text style={s.composePickBtnText}>📷 Add Photo</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Map a raw fetch error to a human-friendly empty-state line. Hides
 *  scary technical text (TypeError, AbortError, raw stack messages) and
 *  surfaces a useful action instead. */
function friendlyError(e: any): string {
  const msg = String(e?.message ?? '');
  if (e?.name === 'OfflineError' || /offline|no internet|network request failed|timed out/i.test(msg)) {
    return 'No internet — feed will load when you reconnect.';
  }
  if (/server error|5\d\d/i.test(msg)) {
    return 'Server hiccup. Pull down to retry.';
  }
  if (/not authenticated|invalid token|missing token/i.test(msg)) {
    return 'Session expired. Sign in again.';
  }
  return msg || 'Could not load feed.';
}

/** "5m ago" / "3h ago" / "Apr 8" — keeps card timestamps short. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  empty: { color: C.text, fontWeight: '700', fontSize: 16 },
  emptySub: { color: C.textMuted, fontSize: 12, marginTop: 8, textAlign: 'center', paddingHorizontal: 30 },

  // Global / Local / Friends segmented toggle, pinned just under the header.
  scopeBar: {
    flexDirection: 'row', marginHorizontal: 16, marginBottom: 10,
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    padding: 3,
  },
  scopeTab: { flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  scopeTabActive: { backgroundColor: C.gold },
  scopeTabText: { color: C.textMuted, fontWeight: '700', fontSize: 13 },
  scopeTabTextActive: { color: C.bg },

  card: {
    backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    marginBottom: 10, padding: 14, marginHorizontal: 16,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  headerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: { backgroundColor: C.gold + '33', alignItems: 'center', justifyContent: 'center' },
  avatarFallbackText: { color: C.gold, fontWeight: '900', fontSize: 15 },
  authorName: { color: C.text, fontWeight: '700', fontSize: 14 },
  timestamp: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  fof: { color: C.gold + 'aa', fontStyle: 'italic' },
  deleteX: { color: C.textMuted, fontSize: 22, fontWeight: '700', paddingHorizontal: 8 },
  reportFlag: { color: C.textMuted, fontSize: 15, paddingHorizontal: 8 },

  bodyText: { color: C.text, fontSize: 15, lineHeight: 21 },

  photo: {
    width: '100%', aspectRatio: 1, borderRadius: 6,
    backgroundColor: C.bg, marginTop: 4,
  },
  caption: { color: C.text, fontSize: 14, lineHeight: 20, marginTop: 10 },

  roundBody: {
    backgroundColor: C.bg, borderRadius: 6, padding: 12,
    borderWidth: 1, borderColor: C.gold + '33',
  },
  roundCourse: { color: C.gold, fontWeight: '800', fontSize: 13 },
  roundScoreRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  roundScore: { fontFamily: F.serif, fontWeight: '900', fontSize: 32 },
  roundDelta: { fontFamily: F.serif, fontWeight: '700', fontSize: 18 },
  roundMeta: { color: C.textMuted, fontSize: 11, marginTop: 6, letterSpacing: 0.4 },
  resultBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  resultWin: { borderColor: C.green },
  resultTie: { borderColor: C.border },
  resultLoss: { borderColor: '#FF6B6B' },
  resultText: { fontWeight: '900', fontSize: 11, letterSpacing: 0.8 },

  composeFab: {
    position: 'absolute', bottom: 20, right: 20,
    paddingHorizontal: 18, paddingVertical: 12, borderRadius: 24,
    backgroundColor: C.gold,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  composeFabText: { color: C.bg, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },

  composeHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 18, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  composeTitle: { color: C.text, fontWeight: '900', fontSize: 16 },
  composeCancel: { color: C.textMuted, fontSize: 14 },
  composePost: { color: C.gold, fontWeight: '900', fontSize: 14, letterSpacing: 0.5 },

  composeInput: {
    color: C.text, fontSize: 15, lineHeight: 22, minHeight: 120,
    textAlignVertical: 'top',
  },
  charCount: { color: C.textDim, fontSize: 10, alignSelf: 'flex-end', marginTop: 4 },

  composePickBtn: {
    marginTop: 20, paddingVertical: 14, borderRadius: 6, alignItems: 'center',
    borderWidth: 1, borderColor: C.gold + '88', borderStyle: 'dashed', backgroundColor: C.gold + '11',
  },
  composePickBtnText: { color: C.gold, fontWeight: '800', fontSize: 14 },

  composeImageWrap: { marginTop: 20, position: 'relative' },
  composeImage: { width: '100%', aspectRatio: 1, borderRadius: 6 },
  composeImageRemove: {
    position: 'absolute', top: 8, right: 8,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center',
  },
  composeImageRemoveText: { color: '#fff', fontSize: 18, fontWeight: '900', lineHeight: 20 },

  // ── Comments ──────────────────────────────────────────────────────────
  commentBar: {
    marginTop: 12, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: C.border + '88',
  },
  commentBarText: { color: C.textMuted, fontSize: 13, fontWeight: '700' },
  commentsEmpty: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 24, fontStyle: 'italic' },
  commentRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border + '55',
  },
  commentAvatar: { width: 32, height: 32, borderRadius: 16 },
  commentAuthor: { color: C.text, fontWeight: '800', fontSize: 13 },
  commentBody: { color: C.text, fontSize: 14, lineHeight: 19, marginTop: 2 },
  commentTime: { color: C.textDim, fontSize: 10, marginTop: 3 },
  commentComposer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  commentInput: {
    flex: 1, color: C.text, fontSize: 15, maxHeight: 100,
    backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 9,
  },
  commentSendBtn: {
    backgroundColor: C.gold, borderRadius: 18,
    paddingHorizontal: 16, paddingVertical: 10, minWidth: 56, alignItems: 'center',
  },
  commentSendText: { color: C.bg, fontWeight: '900', fontSize: 13 },
});
