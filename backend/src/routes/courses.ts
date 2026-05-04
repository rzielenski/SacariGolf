import { Router, Request, Response } from 'express';
import pool from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

const router = Router();

router.get('/nearby', requireAuth, wrap(async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (isNaN(lat) || isNaN(lng)) return res.json([]);
  const { rows } = await pool.query(
    `SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY (latitude - $1)^2 + (longitude - $2)^2
     LIMIT $3`,
    [lat, lng, limit]
  );
  return res.json(rows);
}));

router.get('/search', requireAuth, wrap(async (req: Request, res: Response) => {
  const q = (req.query.q as string) || '';
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (!q.trim()) return res.json([]);
  const { rows } = await pool.query(
    `SELECT course_id, course_name, club_name, city, state, country, latitude, longitude
     FROM courses
     WHERE course_name ILIKE $1 OR club_name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1
     ORDER BY
       CASE WHEN city ILIKE $2 THEN 0
            WHEN state ILIKE $2 THEN 1
            ELSE 2 END,
       course_name
     LIMIT $3`,
    [`%${q}%`, `%${q}%`, limit]
  );
  return res.json(rows);
}));

router.get('/:id', requireAuth, wrap(async (req: Request, res: Response) => {
  const { rows: courseRows } = await pool.query(
    `SELECT course_id, course_name, club_name, address, city, state, country, latitude, longitude
     FROM courses WHERE course_id = $1`,
    [req.params.id]
  );
  if (!courseRows.length) return res.status(404).json({ error: 'Course not found' });

  const { rows: teeRows } = await pool.query(
    `SELECT teebox_id, name, gender, course_rating, slope_rating, total_yards, num_holes, par,
            front_course_rating, front_slope_rating, back_course_rating, back_slope_rating
     FROM teeboxes WHERE course_id = $1 ORDER BY total_yards DESC`,
    [req.params.id]
  );

  const teeboxIds = teeRows.map((t) => t.teebox_id);
  let holes: any[] = [];
  if (teeboxIds.length > 0) {
    const { rows: holeRows } = await pool.query(
      `SELECT hole_id, teebox_id, hole_num, par, yardage, handicap
       FROM holes WHERE teebox_id = ANY($1) ORDER BY teebox_id, hole_num`,
      [teeboxIds]
    );
    holes = holeRows;
  }

  const teeboxes = teeRows.map((t) => ({
    ...t,
    holes: holes.filter((h) => h.teebox_id === t.teebox_id),
  }));

  return res.json({ ...courseRows[0], teeboxes });
}));

export default router;
