/**
 * Followers list — i.e. everyone who sent this user a friend request that
 * was accepted. Mirror screen of /user/[id]/following.
 */

import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { FollowList } from '../../../components/FollowList';
import { api } from '../../../lib/api';

export default function FollowersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api.users.followers(id).then(setItems).catch(() => setItems([]));
  }, [id]);
  return <FollowList title="Followers" data={items} emptyText="No followers yet." />;
}
