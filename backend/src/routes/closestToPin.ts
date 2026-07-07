/**
 * Weekly Closest to the Pin.
 *   GET /closest-to-pin  → per-distance-bucket boards for the current Sacari-Cup
 *                          week, plus the caller's best in each bucket.
 *
 * "Distance to pin" is the FIRST PUTT distance on a hole — exactly how close the
 * approach finished. Putts are TYPED by the player (hole_stats.puttDistances, in
 * feet), not GPS-tracked, so we read puttDistances[0], NOT any on-green shot
 * track (the old version keyed on club='putter' shots that essentially never
 * exist, so every board came back empty). The bucket is the APPROACH's length:
 * the LAST tracked shot on the hole (the one that finished on/near the green).
 * So a 140-yard approach that leaves a 6-foot first putt is a 6 ft entry in the
 * 100-150 bucket. Lowest distance wins each bucket.
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
     -- APPROACH = the LAST tracked shot on each (user, match, hole) this week.
     -- Putts are TYPED (hole_stats.puttDistances), not GPS-tracked, so the last
     -- tracked non-putter shot is the one that finished on/near the green. Its
     -- length is the approach distance that decides the bucket.
     approach AS (
       -- Attribute by the shot's OWNER: in a scramble the tracker tags each
       -- selected shot with the teammate whose ball it was, and that teammate's
       -- round is mirrored (carries the shared hole_stats), so the pairing below
       -- still lands the putt. COALESCE → the tracker for untagged/solo shots.
       SELECT DISTINCT ON (COALESCE(s.owner_user_id, s.user_id), s.match_id, s.hole_num)
              COALESCE(s.owner_user_id, s.user_id) AS user_id, s.match_id, s.hole_num,
              s.total_yds AS approach_yds
         FROM shots s, wk
        WHERE s.match_id IS NOT NULL AND s.hole_num IS NOT NULL
          AND s.club <> 'putter'
          AND s.total_yds IS NOT NULL AND s.total_yds > 0
          AND s.recorded_at >= wk.start
        ORDER BY COALESCE(s.owner_user_id, s.user_id), s.match_id, s.hole_num, s.shot_index DESC
     ),
     -- FIRST-PUTT distance (typed feet) per (user, match, hole) — exactly how
     -- close the approach finished. hole_stats is a positional JSON array;
     -- ordinality is 1-based and maps to the actual hole number (+9 for a
     -- back-nine round). puttDistances[0] is the first putt on the hole.
     first_putt AS (
       SELECT r.user_id, r.match_id,
              (hs.ord + CASE WHEN m.holes_subset = 'back' THEN 9 ELSE 0 END)::int AS hole_num,
              (hs.stat->'puttDistances'->>0)::numeric AS proximity_ft
         FROM rounds r
         JOIN matches m ON m.match_id = r.match_id
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.hole_stats::jsonb) = 'array'
                THEN r.hole_stats::jsonb ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS hs(stat, ord)
        WHERE jsonb_typeof(hs.stat->'puttDistances') = 'array'
          AND jsonb_array_length(hs.stat->'puttDistances') >= 1
     ),
     -- Pair the tracked approach with that hole's first-putt distance.
     paired AS (
       SELECT a.user_id, a.approach_yds, fp.proximity_ft
         FROM approach a
         JOIN first_putt fp
           ON fp.user_id = a.user_id AND fp.match_id = a.match_id
          AND fp.hole_num = a.hole_num
        WHERE fp.proximity_ft > 0 AND fp.proximity_ft <= 120
     ),
     bucketed AS (
       SELECT user_id, proximity_ft, approach_yds,
              CASE WHEN approach_yds < 100  THEN 'u100'
                   WHEN approach_yds <= 150 THEN '100_150'
                   WHEN approach_yds <= 200 THEN '151_200'
                   ELSE '201_plus' END AS bucket
         FROM paired
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
