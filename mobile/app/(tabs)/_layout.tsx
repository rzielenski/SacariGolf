import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { C } from '../../lib/colors';
import { api } from '../../lib/api';

export default function TabLayout() {
  // Pending-invite count for the Chats-tab badge. Push notifications are the
  // primary way an invitee learns they were invited, but pushes silently
  // no-op when the token is stale or notifications are off — so without this
  // badge an invite could sit unseen forever. The badge makes "you have
  // invites waiting" discoverable in-app regardless of push. Polled every 30s
  // and refreshed whenever the app returns to the foreground.
  const [inviteCount, setInviteCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [mi, ci] = await Promise.all([
          api.invites.list().catch(() => []),
          api.clans.clanInvites().catch(() => []),
        ]);
        if (cancelled) return;
        const total = (Array.isArray(mi) ? mi.length : 0) + (Array.isArray(ci) ? ci.length : 0);
        setInviteCount(total);
      } catch { /* leave the badge as-is on error */ }
    };
    refresh();
    const interval = setInterval(refresh, 30000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { cancelled = true; clearInterval(interval); sub.remove(); };
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: C.surface,
          borderTopColor: C.border,
          borderTopWidth: 1,
          height: 80,
          paddingBottom: 16,
        },
        tabBarActiveTintColor: C.gold,
        tabBarInactiveTintColor: C.textDim,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      {/* ── 4-tab layout (UX feedback: 6 tabs overwhelmed new players) ──
          Home · Play · Team · Profile. Courses folded into the Play flow,
          Finds lives on the Home hub, and Chats moved to a top-corner icon
          on Home. Those three screens stay ROUTABLE below via href:null —
          same paths, just no tab-bar slot. */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="play"
        options={{
          title: 'Play',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="golf" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          // The people hub: match + team invites (the badge), my teams,
          // friends. One obvious place to accept anything.
          title: 'Team',
          tabBarBadge: inviteCount > 0 ? inviteCount : undefined,
          tabBarBadgeStyle: { backgroundColor: C.gold, color: '#000', fontWeight: '900' },
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />

      {/* Hidden-but-routable former tabs. href:null removes the tab-bar
          entry while keeping the routes alive, so every existing
          router.push('/courses' | '/finds' | deep link to chats) still works
          with zero file moves. */}
      <Tabs.Screen name="courses" options={{ href: null }} />
      <Tabs.Screen name="finds" options={{ href: null }} />
      <Tabs.Screen name="social" options={{ href: null }} />
    </Tabs>
  );
}
