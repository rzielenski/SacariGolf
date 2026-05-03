import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db/pool';

const router = Router();

function makeToken(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

// Email/password auth
router.post('/register', async (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password required' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING user_id, username, email, elo, total_matches, total_wins, created_at`,
      [username.trim(), email.toLowerCase().trim(), hash]
    );
    return res.status(201).json({ token: makeToken(rows[0].user_id), user: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, email, password_hash, elo, total_matches, total_wins, avatar_url, created_at
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(404).json({ error: 'No account with that email' });
    const user = rows[0];
    if (!user.password_hash) return res.status(401).json({ error: 'This account uses Google Sign-In' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Wrong password' });
    const { password_hash, ...safeUser } = user;
    return res.json({ token: makeToken(user.user_id), user: safeUser });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
