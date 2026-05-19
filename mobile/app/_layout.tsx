import { useEffect, useState } from 'react';
import { Platform, AppState, Keyboard } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AuthProvider, useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { init as initPurchases } from '../lib/purchases';
import { ONBOARDING_KEY, setOnboardedState, subscribeOnboardedState } from '../lib/onboardingState';
import { HomeCoursePreloader } from '../components/HomeCoursePreloader';
import { MatchFoundWatcher } from '../components/MatchFoundWatcher';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { OfflineBanner } from '../components/OfflineBanner';
import { installOutboxDrainTriggers } from '../lib/outbox';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
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
  // — match invites carry `type: 'invite'` (see `invites.ts`). When the user
  // taps the system notification we route them to where they can act on it:
  //   • invite        → social tab (invites list at the top of the screen)
  //   • matchFound    → match lobby (already covered by MatchFoundWatcher,
  //                     but the explicit tap is a nicer UX than waiting for
  //                     the poll)
  // Other types are left for their own handlers / no-op.
  useEffect(() => {
    if (!user) return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification?.request?.content?.data as any;
      if (!data) return;
      if (data.type === 'invite') {
        // Social tab houses the pending-invites list at the top — landing
        // here gives the player a one-tap accept/decline UI.
        router.push('/(tabs)/social' as any);
      } else if (data.type === 'matchFound' && typeof data.matchId === 'string') {
        router.push(`/match/${data.matchId}` as any);
      } else if (data.type === 'round_started' && typeof data.userId === 'string') {
        // Friend started a round — open their profile, which renders the
        // live in-progress round card with the running scorecard / spectate
        // button. (matchId is on the push too if we ever want a deep-link
        // straight to spectate mode.)
        router.push(`/user/${data.userId}` as any);
      }
    });
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

export default function RootLayout() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <StatusBar style="light" />
        <KeyboardDismissOnBackground />
        <OfflineBanner />
        <AuthGuard />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000000' } }}>
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="tournaments" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="tournament/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="blocked-users" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="match/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="match/scoring/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="chat/[type]/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="leaderboard" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/admin-pins/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="user/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="stats" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="premium" options={{ animation: 'slide_from_bottom', headerShown: true, presentation: 'modal' }} />
        <Stack.Screen name="club-heatmap" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="bag" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="matches" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="teams"   options={{ animation: 'slide_from_right', headerShown: true }} />
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
        <Stack.Screen name="verify-email" options={{ animation: 'slide_from_bottom', presentation: 'modal' }} />
      </Stack>
      </AuthProvider>
    </AppErrorBoundary>
  );
}
