/**
 * Following list for a user — i.e. everyone they sent and had an accepted
 * friend request to. Each row is tappable to navigate to that user's
 * profile, letting the player walk the social graph from any profile.
 *
 * When the viewer is looking at THEIR OWN following list, we also render
 * a username-search bar at the top so they can find new players to add as
 * friends — this surface replaces the old Social → Friends sub-tab.
 *
 * The screen is "stateless" — pulls fresh from the server each mount.
 */

import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FollowList } from '../../../components/FollowList';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

export default function FollowingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api.users.following(id).then(setItems).catch(() => setItems([]));
  }, [id]);
  const isSelf = user?.user_id === id;
  return (
    <FollowList
      title="Following"
      data={items}
      emptyText="Not following anyone yet."
      showAddFriend={isSelf}
    />
  );
}
