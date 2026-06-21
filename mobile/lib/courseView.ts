import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HAS_MAPBOX } from './mapbox';

/**
 * Whether to render maps as the 3D course view. True only when the user's
 * "3D course view" setting is on AND a Mapbox token is configured (otherwise
 * every surface falls back to the existing 2D map). Read once on mount; map
 * screens re-mount on navigation, so a setting change is picked up next visit.
 *
 * Shared by every map surface so the single Settings toggle controls them all.
 */
export function useCourseView3D(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem('coc_course_3d')
      .then((v) => { if (!cancelled) setOn(v === '1'); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return on && HAS_MAPBOX;
}
