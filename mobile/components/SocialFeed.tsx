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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  FlatList, RefreshControl, Image, Modal, TextInput, ScrollView,
  KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { api, API_BASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { C, F } from '../lib/colors';
import { censorText } from '../lib/censor';
import { MentionInput } from './MentionInput';
import { IdentityAvatar, IdentityName } from './UserIdentity';
import { Ionicons } from '@expo/vector-icons';

interface Props {
  /** Anything that should render above the feed items inside the same
   *  FlatList — typically the home tab's stats + nav shortcuts. */
  headerComponent?: React.ReactElement | null;
  /** Optional callback run alongside the feed reload when the user pulls
   *  to refresh. Use this to refresh stats / banners that live in the
   *  header. */
  onRefreshExtra?: () => Promise<void> | void;
}

/** Idempotency key for a single comment send attempt. The server has a
 *  partial unique index on (user_id, client_id), so retrying with the same
 *  id can never duplicate the comment — which makes retry-after-timeout
 *  safe. Same scheme as chat sends. */
function genClientId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** Feed audience. Mirrors the backend `?scope=` param on GET /posts/feed. */
type FeedScope = 'global' | 'local' | 'friends';
const SCOPES: { key: FeedScope; label: string }[] = [
  { key: 'global', label: 'Global' },
  { key: 'local', label: 'Local' },
  { key: 'friends', label: 'Friends' },
];

/** Posts per page — small first paint, then infinite-scroll more in. */
const PAGE_SIZE = 10;

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
  // Infinite scroll: load a page at a time, fetch the next page when the user
  // nears the bottom. `hasMore` goes false once a page comes back short.
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadingMoreRef = useRef(false);   // guards against double onEndReached
  const postsRef = useRef<any[]>(posts);
  postsRef.current = posts;               // latest list for the cursor
  // Hold onRefreshExtra in a ref so it does NOT feed `load`'s deps. The parent
  // (home tab) passes a fresh function each render; if `load` depended on it,
  // every parent re-render would re-fire the initial load and wipe the pages
  // the user already scrolled in — exactly the "new posts vanish + loop" bug.
  const onRefreshExtraRef = useRef(onRefreshExtra);
  onRefreshExtraRef.current = onRefreshExtra;

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      // Run the optional caller-supplied refresh (e.g. refreshUser for
      // the home tab) in parallel with the feed fetch so a single pull
      // updates everything in one round-trip wait.
      const [res] = await Promise.all([
        api.posts.feed({ limit: PAGE_SIZE, scope }),
        isRefresh && onRefreshExtraRef.current ? Promise.resolve(onRefreshExtraRef.current()) : Promise.resolve(),
      ]);
      const list = res.posts ?? [];
      setPosts(list);
      setHasMore(list.length >= PAGE_SIZE);
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
  }, [scope]);

  /** Fetch the next page (older posts) using a keyset cursor built from the
   *  last loaded post: "createdAt|postId". Appended, de-duped by post_id. */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    const cur = postsRef.current;
    const last = cur[cur.length - 1];
    if (!last?.created_at || !last?.post_id) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await api.posts.feed({
        limit: PAGE_SIZE, scope, before: `${last.created_at}|${last.post_id}`,
      });
      const more = res.posts ?? [];
      if (more.length) {
        setPosts((prev) => {
          const seen = new Set(prev.map((p) => p.post_id));
          return [...prev, ...more.filter((p: any) => !seen.has(p.post_id))];
        });
      }
      setHasMore(more.length >= PAGE_SIZE);
    } catch {
      // Leave the list as-is; a later scroll retries.
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, scope]);

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
    setHasMore(true);
    loadingMoreRef.current = false;
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
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore
            ? <ActivityIndicator color={C.gold} style={{ marginVertical: 20 }} />
            : null
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
          <IdentityAvatar
            visual={(post as any).author_equipped}
            username={post.author_username}
            avatarUrl={post.author_avatar}
            size={36}
          />
          <View style={{ flex: 1 }}>
            <IdentityName visual={(post as any).author_equipped} style={s.authorName}>
              {post.author_username ? censorText(post.author_username, censor) : 'Unknown'}
            </IdentityName>
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

      {post.kind === 'round' && (
        <>
          <RoundCardBody post={post} />
          {/* Optional note the player attached at submit (may @mention others). */}
          {post.body && <MentionText text={post.body} censor={censor} style={s.caption} />}
        </>
      )}
      {post.kind === 'text' && post.body && (
        <MentionText text={post.body} censor={censor} style={s.bodyText} />
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
          {post.body && <MentionText text={post.body} censor={censor} style={s.caption} />}
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
  const { user } = useAuth();
  const [comments, setComments] = useState<any[] | null>(null);
  const [draft, setDraft] = useState('');
  // One-level reply target (the top-level comment being replied to) + a staged
  // camera-roll image; both clear after a successful submit.
  const [replyTo, setReplyTo] = useState<{ topId: string; username: string } | null>(null);
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string; mime: string } | null>(null);
  // Mirror of `comments` so transitions (optimistic append, confirm swap,
  // retry, discard) can compute the next array without functional-updater
  // gymnastics, and so the badge count can be derived in one place.
  const commentsRef = useRef<any[] | null>(null);
  // Local comments not yet confirmed by the server, keyed by client_id.
  // Merged view = server rows + these; a local whose client_id shows up in
  // a server row is dropped (its send landed — covers the "request
  // succeeded but the response timed out" case).
  const localsRef = useRef<Map<string, any>>(new Map());

  /** Single setter: keeps the ref mirror in sync and reports the badge
   *  count — confirmed rows only, so a pending/failed local never inflates
   *  the card's comment count. */
  const apply = useCallback((rows: any[]) => {
    commentsRef.current = rows;
    setComments(rows);
    onCountChange(rows.filter((r) => !r._status).length);
  }, [onCountChange]);

  const mergeServer = useCallback((server: any[]) => {
    const locals = localsRef.current;
    for (const c of server) {
      if (c.client_id && locals.has(c.client_id)) locals.delete(c.client_id);
    }
    return [...server, ...Array.from(locals.values())];
  }, []);
  // Keyboard height, tracked manually. KeyboardAvoidingView mis-measures its
  // own frame inside a pageSheet Modal (the sheet is inset from the top of
  // the window), so on iOS it under-shifts and the composer stays hidden
  // behind the keyboard — you'd type blind. Instead we read the real keyboard
  // height and pad the bottom of the modal by exactly that, lifting the
  // composer to sit right above the keyboard regardless of presentation.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return; // Android: adjustResize handles it
    const show = Keyboard.addListener('keyboardWillShow', (e) =>
      setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  // Reset when the sheet closes so it reopens flush.
  useEffect(() => { if (!visible) setKbHeight(0); }, [visible]);

  const load = useCallback(async () => {
    try {
      const rows = await api.posts.comments(postId);
      apply(mergeServer(rows));
    } catch {
      // Failed (re)fetch — keep whatever we're already showing rather than
      // blanking the thread; just seed the empty state on a cold open.
      // No count report so the badge keeps its last-known value.
      if (!commentsRef.current) { commentsRef.current = []; setComments([]); }
    }
  }, [postId, apply, mergeServer]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  /** POST one comment. On success the optimistic row is swapped for the
   *  confirmed row; on failure it flips to 'failed' (tap to retry).
   *  Retries reuse the same clientId, so duplicates are impossible. */
  const postComment = useCallback(async (
    clientId: string, body: string,
    parentId: string | null,
    image: { base64: string; mime: string } | null,
  ) => {
    try {
      const r = await api.posts.addComment(postId, body, {
        clientId, parentCommentId: parentId ?? undefined,
        imageBase64: image?.base64, imageMime: image?.mime,
      });
      const cur = localsRef.current.get(clientId);
      localsRef.current.delete(clientId);
      const confirmed = {
        ...(cur ?? { user_id: user?.user_id, username: user?.username, body, mine: true }),
        comment_id: r.comment_id,
        created_at: r.created_at,
        client_id: r.client_id ?? clientId,
        parent_comment_id: r.parent_comment_id ?? parentId ?? null,
        image_url: r.image_url ?? cur?.image_url ?? null,
        _status: undefined,
        _failReason: undefined,
        _imageBase64: undefined,
        _imageMime: undefined,
      };
      const without = (commentsRef.current ?? []).filter((c) =>
        (c.client_id ?? c.comment_id) !== clientId && c.comment_id !== confirmed.comment_id);
      apply([...without, confirmed]);
    } catch (e: any) {
      // 4xx = the server understood and said no (post deleted...). Surface
      // the reason — a retry without fixing the cause fails the same way.
      // Network-class failures stay quiet: the row shows the retry state.
      const rejected = typeof e?.status === 'number' && e.status >= 400 && e.status < 500;
      const cur = localsRef.current.get(clientId);
      if (cur) {
        const failed = {
          ...cur, _status: 'failed',
          _failReason: rejected ? (e?.message ?? 'Could not post') : undefined,
        };
        localsRef.current.set(clientId, failed);
        apply((commentsRef.current ?? []).map((c) =>
          (c.client_id ?? c.comment_id) === clientId ? failed : c));
      }
      if (rejected) Alert.alert('Could not comment', e?.message ?? 'Try again.');
    }
  }, [postId, user?.user_id, user?.username, apply]);

  /** Flip a failed comment back to 'sending' and re-POST it. */
  const retryLocal = useCallback((clientId: string) => {
    const cur = localsRef.current.get(clientId);
    if (!cur) return;
    const again = { ...cur, _status: 'sending', _failReason: undefined };
    localsRef.current.set(clientId, again);
    apply((commentsRef.current ?? []).map((c) =>
      (c.client_id ?? c.comment_id) === clientId ? again : c));
    void postComment(clientId, again.body, again.parent_comment_id ?? null,
      again._imageBase64 ? { base64: again._imageBase64, mime: again._imageMime } : null);
  }, [apply, postComment]);

  /** Remove a failed local comment that never reached the server. */
  const discardLocal = useCallback((clientId: string) => {
    localsRef.current.delete(clientId);
    apply((commentsRef.current ?? []).filter((c) =>
      (c.client_id ?? c.comment_id) !== clientId));
  }, [apply]);

  const pickImage = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, base64: true,
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const a = result.assets[0];
    setPendingImage({ uri: a.uri, base64: a.base64!, mime: a.mimeType ?? 'image/jpeg' });
  }, []);

  const submit = () => {
    const body = draft.trim();
    if ((!body && !pendingImage) || !user) return;
    setDraft('');
    const img = pendingImage;
    const parent = replyTo;
    setPendingImage(null);
    setReplyTo(null);
    // Optimistic: the comment appears instantly in 'sending' state and the
    // POST happens behind it — same flow as chat bubbles. Failures show an
    // explicit tap-to-retry row instead of silently eating the text.
    const clientId = genClientId();
    const local = {
      comment_id: clientId,
      client_id: clientId,
      created_at: new Date().toISOString(),
      body,
      user_id: user.user_id,
      username: user.username,
      avatar_url: user.avatar_url ?? null,
      mine: true,
      _status: 'sending',
      parent_comment_id: parent?.topId ?? null,
      image_url: img?.uri ?? null,
      _imageBase64: img?.base64,
      _imageMime: img?.mime,
    };
    localsRef.current.set(clientId, local);
    apply([...(commentsRef.current ?? []), local]);
    void postComment(clientId, body, parent?.topId ?? null,
      img ? { base64: img.base64, mime: img.mime } : null);
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

  // Comment image URLs from the server are root-relative (/uploads/...); a
  // staged local pick is a file:// uri. Prefix only the server ones.
  const imgUri = (u: string) => (u.startsWith('/') ? `${API_BASE}${u}` : u);

  // Replying to a reply still threads under the top-level ancestor (one level).
  const startReply = (cm: any) =>
    setReplyTo({ topId: cm.parent_comment_id ?? cm.comment_id, username: cm.username });

  // Shared row renderer for both top-level comments and their indented replies.
  const renderRow = (cm: any, isReply: boolean) => (
    <TouchableOpacity
      key={cm.client_id ?? cm.comment_id}
      style={[s.commentRow, isReply && s.commentReplyRow, cm._status === 'sending' && { opacity: 0.55 }]}
      disabled={cm._status !== 'failed'}
      onPress={() => cm.client_id && retryLocal(cm.client_id)}
      activeOpacity={0.7}
    >
      <TouchableOpacity onPress={() => router.push(`/user/${cm.user_id}` as any)}>
        {cm.avatar_url ? (
          <Image
            source={{ uri: cm.avatar_url.startsWith('http') ? cm.avatar_url : `${API_BASE}${cm.avatar_url}` }}
            style={[s.commentAvatar, isReply && s.commentAvatarSmall]}
          />
        ) : (
          <View style={[s.commentAvatar, isReply && s.commentAvatarSmall, s.avatarFallback]}>
            <Text style={s.avatarFallbackText}>{censorText(cm.username ?? '?', censor)[0]?.toUpperCase()}</Text>
          </View>
        )}
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <IdentityName visual={(cm as any).equipped_visual} style={s.commentAuthor}>
          {censorText(cm.username, censor)}
        </IdentityName>
        {!!cm.body && <Text style={s.commentBody}>{censorText(cm.body, censor)}</Text>}
        {cm.image_url ? (
          <Image source={{ uri: imgUri(cm.image_url) }} style={s.commentImage} resizeMode="cover" />
        ) : null}
        {cm._status === 'sending' ? (
          <Text style={s.commentTime}>Sending…</Text>
        ) : cm._status === 'failed' ? (
          <Text style={s.commentFailed}>
            {cm._failReason ? `${cm._failReason} · tap to retry` : 'Not sent · tap to retry'}
          </Text>
        ) : (
          <View style={s.commentMetaRow}>
            <Text style={s.commentTime}>{relativeTime(cm.created_at)}</Text>
            <TouchableOpacity onPress={() => startReply(cm)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Text style={s.replyBtn}>Reply</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      {cm._status === 'failed' && cm.client_id ? (
        <TouchableOpacity onPress={() => discardLocal(cm.client_id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={s.deleteX}>×</Text>
        </TouchableOpacity>
      ) : cm.mine && !cm._status ? (
        <TouchableOpacity onPress={() => remove(cm.comment_id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={s.deleteX}>×</Text>
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );

  // Group into one level: top-level comments, each followed by its replies.
  const tops = (comments ?? []).filter((c) => !c.parent_comment_id);
  const repliesByParent = new Map<string, any[]>();
  for (const c of comments ?? []) {
    if (!c.parent_comment_id) continue;
    const arr = repliesByParent.get(c.parent_comment_id) ?? [];
    arr.push(c);
    repliesByParent.set(c.parent_comment_id, arr);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingBottom: kbHeight }}>
        <View style={s.composeHeader}>
          <TouchableOpacity onPress={onClose}>
            <Text style={s.composeCancel}>Close</Text>
          </TouchableOpacity>
          <Text style={s.composeTitle}>Comments</Text>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          {comments === null ? (
            <ActivityIndicator color={C.gold} style={{ marginTop: 24 }} />
          ) : comments.length === 0 ? (
            <Text style={s.commentsEmpty}>No comments yet — be the first.</Text>
          ) : (
            tops.map((top) => (
              <View key={top.client_id ?? top.comment_id}>
                {renderRow(top, false)}
                {(repliesByParent.get(top.comment_id) ?? []).map((rep) => renderRow(rep, true))}
              </View>
            ))
          )}
        </ScrollView>

        {replyTo && (
          <View style={s.replyChip}>
            <Text style={s.replyChipText} numberOfLines={1}>Replying to @{censorText(replyTo.username, censor)}</Text>
            <TouchableOpacity onPress={() => setReplyTo(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={16} color={C.textMuted} />
            </TouchableOpacity>
          </View>
        )}
        {pendingImage && (
          <View style={s.pendingImageWrap}>
            <Image source={{ uri: pendingImage.uri }} style={s.pendingImage} />
            <TouchableOpacity style={s.pendingImageX} onPress={() => setPendingImage(null)}>
              <Ionicons name="close-circle" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        )}
        <View style={s.commentComposer}>
          <TouchableOpacity onPress={pickImage} style={s.commentImgBtn} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
            <Ionicons name="image-outline" size={24} color={C.gold} />
          </TouchableOpacity>
          <MentionInput
            style={s.commentInput}
            containerStyle={{ flex: 1 }}
            dropdownAbove
            value={draft}
            onChangeText={setDraft}
            placeholder={replyTo ? `Reply to @${replyTo.username}…` : 'Add a comment… @ to tag'}
            placeholderTextColor={C.textMuted}
            maxLength={280}
            multiline
          />
          <TouchableOpacity
            style={[s.commentSendBtn, (!draft.trim() && !pendingImage) && { opacity: 0.4 }]}
            onPress={submit}
            disabled={!draft.trim() && !pendingImage}
            activeOpacity={0.7}
          >
            <Text style={s.commentSendText}>Post</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// Splits on @mentions while KEEPING the tokens (capturing group), so we can
// render the handles in gold and make them tappable. 3–20 chars matches the
// username rules + the server-side mention parser.
const MENTION_SPLIT = /(@[a-zA-Z0-9_]{3,20})/g;
const MENTION_TEST = /^@[a-zA-Z0-9_]{3,20}$/;

/** Resolve a tapped @handle to a user and open their profile. Best-effort —
 *  a misspelled handle that matches nobody just no-ops. */
function openMentionedUser(token: string) {
  const handle = token.replace(/^@/, '').toLowerCase();
  api.users.search(handle)
    .then((rows: any[]) => {
      const u = (rows ?? []).find((r) => r.username?.toLowerCase() === handle);
      if (u) router.push(`/user/${u.user_id}` as any);
    })
    .catch(() => { /* silent */ });
}

/** Renders a post body with @mentions highlighted + tappable. Censoring is
 *  applied first (usernames are alphanumeric so they survive the censor). */
function MentionText({ text, censor, style }: { text: string; censor: boolean; style?: any }) {
  const censored = censorText(text, censor);
  const parts = censored.split(MENTION_SPLIT);
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        MENTION_TEST.test(part) ? (
          <Text key={i} style={s.mention} onPress={() => openMentionedUser(part)}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/** Round card body — pulls from the server-joined match fields. */
function RoundCardBody({ post }: { post: any }) {
  const strokes = post.author_strokes;
  // Par is the SUM of the per-hole pars across the slice of holes the
  // author actually played, computed server-side in the same way the
  // round-recap scorecard does it (see backend/src/routes/posts.ts +
  // mobile/components/Scorecard.tsx buildGridData). Every previous "post
  // says +23 but the recap says +3" bug came from this card pro-rating
  // teebox.par by hole-count instead of summing real per-hole pars; the
  // two disagreed on partial scoring, asymmetric nines, and stale
  // match.num_holes. We now use the recap's number directly.
  //
  // Fallback: posts created before the server started returning this
  // field, or against a course that lacks per-hole data, fall back to
  // the old pro-rate. That keeps historical posts non-blank.
  const teeboxPar       = typeof post.teebox_par       === 'number' ? post.teebox_par       : null;
  const teeboxNumHoles  = typeof post.teebox_num_holes === 'number' ? post.teebox_num_holes : null;
  const matchNumHoles   = typeof post.match_num_holes  === 'number' ? post.match_num_holes  : null;
  const playedPar       = typeof post.author_played_par === 'number' && post.author_played_par > 0
    ? post.author_played_par : null;
  const holesPlayed = typeof post.author_holes_played === 'number' && post.author_holes_played > 0
    ? post.author_holes_played : matchNumHoles;
  let par: number | null = playedPar;
  if (par == null) {
    // Legacy fallback path — kept only for posts predating author_played_par.
    par = teeboxPar;
    if (teeboxPar != null && teeboxNumHoles && holesPlayed && holesPlayed !== teeboxNumHoles) {
      par = Math.round(teeboxPar * (holesPlayed / teeboxNumHoles));
    }
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

  // Win/loss is PER PERSON: this author gained SR → win, lost → loss, 0 → tie.
  // Essential for Arena (FFA), where everyone shares a side so winner_side
  // would otherwise mark the whole field a winner. Legacy posts without a
  // per-player delta fall back to the winner_side vs author_side comparison.
  const myDelta: number | null =
    typeof post.author_elo_delta === 'number' ? post.author_elo_delta : null;
  const wonByMe = myDelta != null
    ? myDelta > 0
    : (typeof post.winner_side === 'number'
        && typeof post.author_side === 'number'
        && post.winner_side === post.author_side);
  const tied = myDelta != null
    ? (!!post.match_completed && myDelta === 0)
    : (post.match_completed && post.winner_side == null);
  // Show the author's own SR swing when known, else the match headline delta.
  const shownDelta = myDelta != null
    ? Math.abs(Math.round(myDelta))
    : (typeof post.delta_elo === 'number' ? post.delta_elo : null);

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
        {shownDelta != null && post.match_completed
          ? ` · ${wonByMe ? '+' : tied ? '±' : '−'}${shownDelta} SR`
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
          <MentionInput
            style={s.composeInput}
            value={body}
            onChangeText={setBody}
            placeholder="What's going on? Share a tip, a win, a wild miss… tag a friend with @"
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
  mention: { color: C.gold, fontWeight: '700' },

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
  commentFailed: { color: C.red, fontSize: 10, marginTop: 3, fontWeight: '700' },
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
  commentReplyRow: { marginLeft: 38, paddingVertical: 8 },
  commentAvatarSmall: { width: 26, height: 26, borderRadius: 13 },
  commentImage: { width: 180, height: 180, borderRadius: 12, marginTop: 6, backgroundColor: C.card },
  commentMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 3 },
  replyBtn: { color: C.textMuted, fontSize: 11, fontWeight: '800' },
  commentImgBtn: { paddingHorizontal: 4, paddingBottom: 8, alignSelf: 'flex-end' },
  replyChip: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 12, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: C.card, borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderColor: C.border,
  },
  replyChipText: { color: C.textMuted, fontSize: 12, flex: 1 },
  pendingImageWrap: { marginHorizontal: 12, marginTop: 8, alignSelf: 'flex-start' },
  pendingImage: { width: 84, height: 84, borderRadius: 10, backgroundColor: C.card },
  pendingImageX: { position: 'absolute', top: -8, right: -8 },
});
