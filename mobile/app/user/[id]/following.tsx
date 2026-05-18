/**
 * Following list for a user — i.e. everyone they sent and had an accepted
 * friend request to. Each row is tappable to navigate to that user's
 * profile, letting the player walk the social graph from any profile.
 *
 * The screen is "stateless" — pulls fresh from the server each mount.
 */

import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FollowList } from '../../../components/FollowList';
import { api } from '../../../lib/api';

export default function FollowingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api.users.following(id).then(setItems).catch(() => setItems([]));
  }, [id]);
  return <FollowList title="Following" data={items} emptyText="Not following anyone yet." />;
}
