/**
 * Followers list — i.e. everyone who sent this user a friend request that
 * was accepted. Mirror screen of /user/[id]/following.
 *
 * When the viewer is looking at THEIR OWN followers list we also render a
 * username-search bar at the top so they can find new players to add —
 * same affordance as the Following screen.
 */

import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FollowList } from '../../../components/FollowList';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

export default function FollowersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api.users.followers(id).then(setItems).catch(() => setItems([]));
  }, [id]);
  const isSelf = user?.user_id === id;
  return (
    <FollowList
      title="Followers"
      data={items}
      emptyText="No followers yet."
      showAddFriend={isSelf}
    />
  );
}
