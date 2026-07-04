import { useEffect, useState } from 'react';
import { Platform, AppState, Keyboard } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AuthProvider, useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { loadAppConfig } from '../lib/appConfig';
import { UpdateBanner } from '../components/UpdateBanner';
import { init as initPurchases } from '../lib/purchases';
import { ONBOARDING_KEY, setOnboardedState, subscribeOnboardedState } from '../lib/onboardingState';
import { HomeCoursePreloader } from '../components/HomeCoursePreloader';
import { MatchFoundWatcher } from '../components/MatchFoundWatcher';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { OfflineBanner } from '../components/OfflineBanner';
import { installOutboxDrainTriggers } from '../lib/outbox';
import { C, IS_LIGHT_SKIN } from '../lib/colors';
import { initCrashReporter, noteRoute } from '../lib/crashReporter';

// Install crash reporting as the FIRST thing at boot so breadcrumbs capture the
// whole session and an abnormal-exit from the previous run gets reported. See
// lib/crashReporter.ts — this is how we catch native force-closes that no JS
// error boundary can see.
initCrashReporter();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // SDK 53+ split the old `shouldShowAlert` into two fields:
    //   • shouldShowBanner — the heads-up banner while the app is OPEN
    //   • shouldShowList   — whether it lands in Notification Center
    // The deprecated `shouldShowAlert` is kept for older runtimes. Without
    // the new fields, foreground notifications (e.g. a team-chat message
    // arriving while you're in the app) were silently NOT displayed —
    // which is a big part of "I'm not getting notifications."
    shouldShowBanner: true,
    shouldShowList: true,
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function AuthGuard() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  // Onboarding gate: shown to authenticated users who haven't yet completed
  // the four-card intro on this device. Lives in AsyncStorage (per-device,
  // not per-user) so reinstalls show it again.
  //
  // CRITICAL: we ALSO subscribe to the shared `onboardingState` module so
  // when the user finishes onboarding, AuthGuard's local flag flips
  // synchronously — otherwise this effect's segment-change handler races
  // ahead and bounces the user right back to /onboarding, infinite loop.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Subscribe FIRST so a setOnboardedState() call during the AsyncStorage
    // read (unlikely but possible) isn't dropped.
    const unsub = subscribeOnboardedState((v) => { if (!cancelled) setOnboarded(v); });
    require('@react-native-async-storage/async-storage').default
      .getItem(ONBOARDING_KEY)
      .then((v: string | null) => {
        if (cancelled) return;
        const flag = !!v;
        // Seed both local state AND the shared module so future subscribers
        // get the initial value immediately.
        setOnboardedState(flag);
      })
      .catch(() => { if (!cancelled) setOnboardedState(true); /* fail open */ });
    return () => { cancelled = true; unsub(); };
  }, []);

  useEffect(() => {
    if (loading || onboarded === null) return;
    const inAuthGroup = segments[0] === '(auth)';
    const onOnboarding = (segments[0] as string) === 'onboarding';
    if (!user && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (user && inAuthGroup) {
      router.replace(onboarded ? '/(tabs)/' as any : '/onboarding' as any);
    } else if (user && !onboarded && !onOnboarding) {
      router.replace('/onboarding' as any);
    }
  }, [user, loading, segments, onboarded]);

  // Register push token once user is logged in
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.MAX,
          });
        }
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;

        // projectId is required by Expo SDK 49+; sourced from app.json extra.eas.projectId
        // or the EAS manifest. Falls back silently if not configured yet.
        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          Constants.easConfig?.projectId;
        if (!projectId) return; // skip push registration until EAS is set up

        const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
        await api.users.update({ pushToken: token });
      } catch { /* push notifications are non-fatal */ }
    })();
  }, [user?.user_id]);

  // Initialize RevenueCat for the current user. No-op when the SDK isn't
  // installed (free-tier builds) so the rest of the app keeps working.
  useEffect(() => {
    if (!user?.user_id) return;
    initPurchases(user.user_id).catch(() => { /* non-fatal */ });
  }, [user?.user_id]);

  // Route notification taps. The backend tags every push with a `data.type`
  // and we route straight to where the user can act on / view it.
  // (See every `sendPush(..., { type: ... })` callsite in backend/src/routes/
  // for the full taxonomy — every type that ships must have a case here.)
  //
  //   • invite         → social tab (invite accept/decline list)
  //   • matchFound     → match lobby
  //   • round_started  → the live match scorecard (the "live round" page).
  //                      Goes to /match/<matchId> so the recipient lands
  //                      directly on the spectatable scorecard rather than
  //                      having to tap through the friend's profile.
  //   • round_finished → same match page; now shows the completed scorecard.
  //   • match_result   → match recap with SR delta + win/loss banner.
  //   • round_reaction → home feed (the round post carries the reactions).
  //   • round_comment  → home feed (the comment thread lives on the post).
  //   • dm             → that 1:1 chat thread
  //   • chat           → that match's chat room
  //   • clan_chat      → that team's chat room
  //
  // CRITICAL: this listener also handles the case where the app was
  // COLD-LAUNCHED by tapping a notification (not just tapped while
  // running). `getLastNotificationResponseAsync()` below replays the tap
  // that opened the app so a killed-app launch still deep-links correctly.
  useEffect(() => {
    if (!user) return;

    const route = (data: any) => {
      if (!data || typeof data !== 'object') return;
      switch (data.type) {
        case 'invite':
          router.push('/(tabs)/social' as any);
          break;
        case 'matchFound':
          if (typeof data.matchId === 'string') router.push(`/match/${data.matchId}` as any);
          break;
        case 'round_started':
        case 'round_finished':
          // Friend started or finished a round → the match scorecard,
          // which is the "live round" for an in-progress match and the
          // recap for a completed one. Both pushes ship with matchId; if
          // it's somehow missing on a legacy payload, fall back to the
          // friend's profile (which renders the live round card too).
          if (typeof data.matchId === 'string') {
            router.push(`/match/${data.matchId}` as any);
          } else if (typeof data.userId === 'string') {
            router.push(`/user/${data.userId}` as any);
          }
          break;
        case 'match_result':
          // Resolved match → recap with SR delta + win/loss banner.
          if (typeof data.matchId === 'string') router.push(`/match/${data.matchId}` as any);
          break;
        case 'round_reaction':
        case 'round_comment':
        case 'round_comment_reply':
          // Reaction, comment, or reply on your round → the home feed, where
          // the round post carries the inline thread. There's no per-round
          // standalone route to deep-link to (the scorecard is a modal).
          router.push('/(tabs)/' as any);
          break;
        case 'dm':
          // Open the 1:1 thread. fromName (when present) gives the chat
          // header its title immediately instead of "Direct Message".
          if (typeof data.fromUserId === 'string') {
            const q = typeof data.fromName === 'string'
              ? `?name=${encodeURIComponent(data.fromName)}` : '';
            router.push(`/chat/dm/${data.fromUserId}${q}` as any);
          }
          break;
        case 'chat':
          // Match chat room.
          if (typeof data.matchId === 'string') router.push(`/chat/match/${data.matchId}` as any);
          break;
        case 'clan_chat':
          // Team chat room.
          if (typeof data.clanId === 'string') router.push(`/chat/clan/${data.clanId}` as any);
          break;
        case 'announcement':
        case 'post':
        case 'mention':
        case 'post_comment':
        case 'post_comment_reply':
        case 'post_like':
          // Tagged in a post/comment, someone commented/replied, or liked your
          // post → open the feed (home tab). There's no per-post screen, so we
          // land the user on the feed where the post + comments appear.
          router.push('/(tabs)/' as any);
          break;
        default:
          break;
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      route(response.notification?.request?.content?.data);
    });

    // Cold-launch replay: if the app was opened by tapping a notification
    // while killed, addNotificationResponseReceivedListener won't fire for
    // it — we have to pull the launching response explicitly. A short delay
    // lets the router mount before we push.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          setTimeout(() => route(response.notification?.request?.content?.data), 400);
        }
      })
      .catch(() => { /* non-fatal */ });

    return () => sub.remove();
  }, [user?.user_id]);

  // Pre-warm map tiles for the user's home course so the next round there
  // loads instantly even on a flaky connection.
  return (
    <>
      <HomeCoursePreloader
        courseId={user?.home_course_id ?? null}
        lat={user?.home_course_lat ?? null}
        lng={user?.home_course_lng ?? null}
      />
      {/* Polls /matches and triggers the VS intro when an opponent appears
          on any of the user's pending matches — works from any screen. */}
      {user && <MatchFoundWatcher />}
    </>
  );
}

/**
 * Dismisses the on-screen keyboard whenever the app moves to background or
 * inactive state. iOS sometimes mis-restores layout dimensions if the
 * keyboard was visible at the moment of suspension — text fields end up
 * pushed off-screen, modals don't recenter, etc. Closing the keyboard before
 * suspension avoids the whole class of bug.
 */
function KeyboardDismissOnBackground() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') {
        Keyboard.dismiss();
      }
    });
    return () => sub.remove();
  }, []);
  return null;
}

// Boot-time outbox installer — wires up auto-drain on connectivity restore
// + app foreground. Idempotent so re-mounts during HMR don't double-bind.
installOutboxDrainTriggers();

/** Drops a breadcrumb every time the active route changes, so a crash report
 *  pinpoints the exact screen the user was on when it died. */
function RouteBreadcrumbs() {
  const segments = useSegments();
  useEffect(() => {
    noteRoute('/' + segments.join('/'));
  }, [segments]);
  return null;
}

/** Fetch server config on boot + every foreground so min_version flips,
 *  banners, and feature flags reach running apps within one resume. */
function AppConfigLoader() {
  useEffect(() => {
    loadAppConfig();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') loadAppConfig();
    });
    return () => sub.remove();
  }, []);
  return null;
}

export default function RootLayout() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        {/* Dark text on light skins (Ultra White), light text on the rest —
            a hardcoded "light" made the clock white-on-white on a pearl bg. */}
        <StatusBar style={IS_LIGHT_SKIN ? 'dark' : 'light'} />
        <KeyboardDismissOnBackground />
        <RouteBreadcrumbs />
        <AppConfigLoader />
        <UpdateBanner />
        <OfflineBanner />
        <AuthGuard />
        {/* C.bg, not literal black: on a light skin a hardcoded #000 flashed
            black behind every screen transition. */}
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="tournaments" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="tournament/[id]" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="creator-leagues" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="join/[code]" options={{ animation: 'fade' }} />
        <Stack.Screen name="blocked-users" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="match/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="match/scoring/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="match/group/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="chat/[type]/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="leaderboard" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/admin-pins/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/admin-tees/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="user/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="stats" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="premium" options={{ animation: 'slide_from_bottom', headerShown: true, presentation: 'modal' }} />
        <Stack.Screen name="club-heatmap" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="bag" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="matches" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="teams"   options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="friends" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="course-request" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="user/[id]/following" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="user/[id]/followers" options={{ animation: 'slide_from_right', headerShown: true }} />
        {/* Range Session routes — need headerShown so the screen has the
            standard nav bar (title + back button), which also pushes the
            scroll content down so the view-mode tabs aren't slammed
            against the status bar / notch. */}
        <Stack.Screen name="range/index" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="range/analyze" options={{ animation: 'slide_from_right', headerShown: true }} />
        {/* Vision-camera-powered swing recorder. Slides up from the bottom
            because it's a focused capture surface — same UX rhythm as
            the system camera. */}
        <Stack.Screen name="range/camera" options={{ animation: 'slide_from_bottom', headerShown: true }} />
        {/* Cosmetics + account suite. These set their own titles via
            Stack.Screen inside the file, but the title only renders if
            the route is registered here with headerShown — the root
            default hides headers, and without the nav bar the content
            starts under the status bar / Dynamic Island. */}
        <Stack.Screen name="locker-room" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="sacari-cup"  options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="season-pass" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="closest-to-pin" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="titles"      options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="settings"    options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="invite"      options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="resume"      options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="dev/vfx-preview"   options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="dev/crest-preview" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="verify-email" options={{ animation: 'slide_from_bottom', presentation: 'modal' }} />
      </Stack>
      </AuthProvider>
    </AppErrorBoundary>
  );
}
