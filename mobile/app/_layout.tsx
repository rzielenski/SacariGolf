import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { AuthProvider, useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { HomeCoursePreloader } from '../components/HomeCoursePreloader';

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

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!user && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (user && inAuthGroup) {
      router.replace('/(tabs)/');
    }
  }, [user, loading, segments]);

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

  // Pre-warm map tiles for the user's home course so the next round there
  // loads instantly even on a flaky connection.
  return (
    <HomeCoursePreloader
      courseId={user?.home_course_id ?? null}
      lat={user?.home_course_lat ?? null}
      lng={user?.home_course_lng ?? null}
    />
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <AuthGuard />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000000' } }}>
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="match/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="match/scoring/[id]" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="chat/[type]/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="leaderboard" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="course/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="user/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="stats" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="premium" options={{ animation: 'slide_from_bottom', headerShown: true, presentation: 'modal' }} />
        <Stack.Screen name="club-heatmap" options={{ animation: 'slide_from_right', headerShown: true }} />
        <Stack.Screen name="verify-email" options={{ animation: 'slide_from_bottom', presentation: 'modal' }} />
      </Stack>
    </AuthProvider>
  );
}
