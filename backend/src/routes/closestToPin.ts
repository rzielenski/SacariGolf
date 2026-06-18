/**
 * Weekly Closest to the Pin.
 *   GET /closest-to-pin  → per-distance-bucket boards for the current Sacari-Cup
 *                          week, plus the caller's best in each bucket.
 *
 * "Distance to pin" is the length of the FIRST PUTT on a hole: a putt means the
 * ball is on the green (so the winner is genuinely putting), and the first
 * putt's length is exactly how close the approach finished. The bucket is the
 * APPROACH's length (the tracked shot immediately before that first putt). So a
 * 140-yard approach that leaves a 6-foot putt is a 6 ft entry in the 100-150
 * bucket. Lowest distance wins each bucket.
 */
import { Router, Response } from 'express';
import pool from '../db/pool';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

const BUCKETS = [
  { key: 'u100',     label: 'Inside 100 yds' },
  { key: '100_150',  label: '100-150 yds' },
  { key: '151_200',  label: '151-200 yds' },
  { key: '201_plus', label: '201+ yds' },
];

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
  const { rows } = await pool.query(
    `WITH wk AS (
       SELECT date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start
     ),
     -- The first putt on each (user, match, hole) this week.
     first_putt AS (
       SELECT DISTINCT ON (s.user_id, s.match_id, s.hole_num)
              s.user_id, s.match_id, s.hole_num, s.shot_index AS pidx,
              s.start_lat, s.start_lng, s.end_lat, s.end_lng
         FROM shots s, wk
        WHERE s.club = 'putter'
          AND s.match_id IS NOT NULL AND s.hole_num IS NOT NULL
          AND s.recorded_at >= wk.start
        ORDER BY s.user_id, s.match_id, s.hole_num, s.shot_index ASC
     ),
     -- Pair each first putt with the approach (the shot right before it). The
     -- putt's start->end length, in feet, is the proximity to the pin.
     approached AS (
       SELECT fp.user_id, a.total_yds AS approach_yds,
              2 * 6371000 * asin(sqrt(
                power(sin(radians(fp.end_lat - fp.start_lat) / 2), 2) +
                cos(radians(fp.start_lat)) * cos(radians(fp.end_lat)) *
                power(sin(radians(fp.end_lng - fp.start_lng) / 2), 2)
              )) * 3.28084 AS proximity_ft
         FROM first_putt fp
         JOIN shots a ON a.user_id = fp.user_id AND a.match_id = fp.match_id
          AND a.hole_num = fp.hole_num AND a.shot_index = fp.pidx - 1
        WHERE a.club <> 'putter' AND a.total_yds IS NOT NULL AND a.total_yds > 0
     ),
     bucketed AS (
       SELECT user_id, proximity_ft, approach_yds,
              CASE WHEN approach_yds < 100  THEN 'u100'
                   WHEN approach_yds <= 150 THEN '100_150'
                   WHEN approach_yds <= 200 THEN '151_200'
                   ELSE '201_plus' END AS bucket
         FROM approached
        WHERE proximity_ft > 0 AND proximity_ft <= 120   -- drop GPS-noise "putts"
     ),
     best AS (
       SELECT DISTINCT ON (user_id, bucket) user_id, bucket, proximity_ft, approach_yds
         FROM bucketed
        ORDER BY user_id, bucket, proximity_ft ASC
     )
     SELECT b.bucket, b.user_id, u.username, u.avatar_url,
            ROUND(b.proximity_ft::numeric, 1) AS proximity_ft, b.approach_yds
       FROM best b
       JOIN users u ON u.user_id = b.user_id
      WHERE u.is_bot = false
      ORDER BY b.bucket, b.proximity_ft ASC`,
  );

  const byBucket: Record<string, any[]> = {};
  for (const r of rows) (byBucket[r.bucket] ??= []).push(r);

  const buckets = BUCKETS.map((b) => {
    const list = byBucket[b.key] ?? [];
    return {
      key: b.key,
      label: b.label,
      rows: list.slice(0, 15).map((r, i) => ({ ...r, rank: i + 1, is_me: r.user_id === req.userId })),
      my_best: list.find((r) => r.user_id === req.userId) ?? null,
    };
  });
  return res.json({ buckets });
}));

export default router;
