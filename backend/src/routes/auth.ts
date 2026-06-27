import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../db/pool';
import { sendEmail } from '../utils/email';
import { sendPush } from '../utils/notify';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

function makeToken(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '30d' });
}

// Pre-computed bcrypt hash of a random string. Used to keep login timing
// constant when the email doesn't exist — without this, an attacker can
// enumerate registered emails by measuring response time (existing email
// triggers bcrypt.compare, missing email returns instantly).
const FAKE_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8.5nQ/hHlt4qJyOJC8yY2JZJZBwYC.';

// In-memory rate limiter keyed by ip+email for login, ip+email for register.
// Fails closed after the threshold; resets after the window. Process-local
// (no Redis) — fine for a single Railway instance; scale-out would need
// shared state.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
// Periodically prune expired buckets so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets.entries()) {
    if (v.resetAt < now) buckets.delete(k);
  }
}, 60_000).unref?.();

function clientIp(req: Request): string {
  // With `trust proxy` set in index.ts, req.ip is the real client IP derived
  // from the validated Railway proxy hop — preferred over the raw, spoofable
  // x-forwarded-for header (which is only a fallback for non-proxied/local runs).
  return req.ip
    || (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    || 'unknown';
}

// Email/password auth
router.post('/register', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  // 10 registrations per IP per hour — generous for legit users, kills bots.
  if (!rateLimit(`reg:${ip}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
  }
  const { username, email, password, referralCode } = req.body ?? {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password required' });
  }
  // Referral code: optional. Tolerate any caller-supplied formatting and
  // normalize to upper-case alphanumeric. We resolve it to an inviter
  // BEFORE creating the account so we can stamp `referred_by_user_id` on
  // the row in one go. An unknown / blank code is not an error — the
  // signup proceeds without a referrer.
  const rcRaw = typeof referralCode === 'string' ? referralCode : '';
  const rc = rcRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  // Validate username: 3–20 chars, alphanumeric + underscore (matches the
  // PATCH /me/username rules so the registered name can later be edited).
  const u = String(username).trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, or underscores' });
  }
  // Basic email shape — keep loose so we don't reject valid addresses.
  const e = String(email).toLowerCase().trim();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return res.status(400).json({ error: 'Enter a valid email' });
  }
  // Password floor — short enough to be friendly, long enough to deter spray.
  const p = String(password);
  if (p.length < 6 || p.length > 200) {
    return res.status(400).json({ error: 'Password must be 6–200 characters' });
  }
  try {
    const hash = await bcrypt.hash(p, 12);
    // Generate a verification code at registration time and store its hash.
    const verifyCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const verifyHash = crypto.createHash('sha256').update(verifyCode).digest('hex');

    // Resolve the referral code (if any) to an inviter user_id BEFORE we
    // insert, so the new row's referred_by_user_id is set in one statement.
    // An unknown code silently falls through to a no-credit signup —
    // never block account creation on a bad code, just don't pay out.
    let inviterId: string | null = null;
    if (rc) {
      const { rows: invRows } = await pool.query(
        `SELECT user_id FROM users WHERE referral_code = $1 LIMIT 1`,
        [rc]
      );
      inviterId = invRows[0]?.user_id ?? null;
    }

    // Generate a referral_code for the new account inline (same expression
    // the backfill migration uses — encode 8 bytes, strip non-[A-Z0-9],
    // take 7 chars). 32^7 ≈ 34B permutations so collisions on a single
    // insert are negligible; the unique index would 23505 if we ever hit one.
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash,
                          email_verify_code_hash, email_verify_expires_at,
                          referral_code, referred_by_user_id)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours',
               upper(substring(translate(encode(gen_random_bytes(8), 'base64'),
                                         '+/=abcdefghijklmnopqrstuvwxyz', ''),
                               1, 7)),
               $5)
       RETURNING user_id, username, email, elo, total_matches, total_wins, created_at, email_verified, referral_code`,
      [u, e, hash, verifyHash, inviterId]
    );
    // Await the send so any failure shows up in Railway logs and the response
    // doesn't return before the email is actually queued. Capped at 8s so a
    // hung Resend call can't stall the registration response indefinitely.
    const emailResult = await Promise.race([
      sendEmail({
        to: e,
        subject: 'Verify your Sacari account',
        text:
          `Welcome to Sacari!\n\n` +
          `Your verification code is: ${verifyCode}\n\n` +
          `Enter it inside the app to confirm your email. The code expires in 24 hours.\n\n` +
          `If you didn't sign up, you can ignore this email.\n\n— Sacari`,
        html:
          `<p>Welcome to Sacari!</p>` +
          `<p>Your verification code is:</p>` +
          `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${verifyCode}</p>` +
          `<p>Enter it inside the app to confirm your email. The code expires in 24 hours.</p>` +
          `<p>If you didn't sign up, you can ignore this email.</p>` +
          `<p>— Sacari</p>`,
      }),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'email_send_timeout' }), 8000)
      ),
    ]);
    if (!emailResult.ok) {
      // eslint-disable-next-line no-console
      console.error('[register] verification email send failed:', emailResult.error);
    }

    // ── Referral payout ───────────────────────────────────────────────
    // The inviter gets one 'lucky_round' perk per new signup that used
    // their code, tagged with earned_reason='referral' so it's
    // distinguishable from the in-match pin/shot-contribution path. The
    // perk model already handles consumption + the win-double / loss-
    // protection mechanic, so no new gameplay code is needed — only the
    // grant + a push so the inviter actually sees the reward landed.
    //
    // FUTURE: once premium becomes paid, switch this to a 7-day premium
    // grant (bump premium_until on the inviter) instead. Today's open-beta
    // posture makes premium days meaningless, so a Lucky Round is the
    // reward that actually changes something for the inviter right now.
    if (inviterId) {
      try {
        await pool.query(
          `INSERT INTO user_perks (user_id, perk_type, earned_reason)
           VALUES ($1, 'lucky_round', 'referral')`,
          [inviterId]
        );
        const { rows: tokRows } = await pool.query(
          `SELECT push_token FROM users WHERE user_id = $1`,
          [inviterId]
        );
        const token = tokRows[0]?.push_token;
        if (token) {
          await sendPush(
            [token],
            'New referral!',
            `${u} signed up with your code. Lucky Round added to your perks.`,
            { type: 'referral', referredUserId: rows[0].user_id }
          );
        }
      } catch (referralErr) {
        // eslint-disable-next-line no-console
        console.error('[register] referral credit failed:', referralErr);
      }
    }

    return res.status(201).json({ token: makeToken(rows[0].user_id), user: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const e = String(email).toLowerCase().trim();
  const p = String(password);
  if (e.length > 254 || p.length > 200) return res.status(400).json({ error: 'Invalid email or password' });

  // Rate-limit by IP and by email separately. Either bucket exhausting blocks.
  // 8 login attempts per IP per 5 min, 8 per email per 5 min.
  if (!rateLimit(`login:ip:${ip}`, 8, 5 * 60 * 1000)
   || !rateLimit(`login:email:${e}`, 8, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many login attempts. Wait a few minutes and try again.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, email, password_hash, elo, total_matches, total_wins, avatar_url, created_at,
              is_premium, premium_since, premium_until, premium_plan
       FROM users WHERE email = $1`,
      [e]
    );

    // Always run bcrypt.compare so response time doesn't reveal whether the
    // email exists (timing-attack protection). If no user, compare against a
    // dummy hash so the work is the same.
    const user = rows[0];
    const hashToCheck = user?.password_hash ?? FAKE_HASH;
    const ok = await bcrypt.compare(p, hashToCheck);

    // The frontend's signup-flow probe uses password '__check__' to detect
    // "is this a new user or existing?". For the probe ONLY we still return
    // distinct messages so the signup branch works. Note this means the
    // probe is the one channel where email enumeration is possible — that's
    // a deliberate trade-off to keep the existing signup UX.
    if (p === '__check__') {
      if (!user) return res.status(404).json({ error: 'No account with that email' });
      if (!user.password_hash) return res.status(401).json({ error: 'This account uses Google Sign-In' });
      return res.status(401).json({ error: 'Wrong password' });
    }

    // Real login — generic errors only (no enumeration leak).
    if (!user || !user.password_hash || !ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Clear this email's failure bucket on success so an honest user isn't
    // throttled for earlier typos.
    buckets.delete(`login:email:${e}`);

    const { password_hash, ...safeUser } = user;
    return res.json({ token: makeToken(user.user_id), user: safeUser });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Forgot password ─────────────────────────────────────────────────────────
//
// Two-step flow:
//   POST /auth/forgot   { email }                  → emails a 6-digit code
//   POST /auth/reset    { email, code, password }  → consumes the code, sets new password
//
// We never reveal whether an email is registered (response is identical for
// both cases) and we hash the code at rest with SHA-256 so a DB leak doesn't
// reveal active codes.

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

router.post('/forgot', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  // 5 reset requests per IP per hour, 3 per email per hour. Generous enough
  // for a forgetful user, tight enough to deter blasting through the whole
  // user table.
  if (!rateLimit(`forgot:ip:${ip}`, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many reset attempts. Try again later.' });
  }
  const email = String(req.body?.email ?? '').toLowerCase().trim();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Generic response — don't differentiate "bad email shape" from "not registered"
    return res.json({ success: true });
  }
  if (!rateLimit(`forgot:email:${email}`, 3, 60 * 60 * 1000)) {
    return res.json({ success: true }); // silent — no leak
  }

  try {
    const { rows } = await pool.query(
      `SELECT user_id, password_hash FROM users WHERE email = $1`,
      [email]
    );
    const user = rows[0];

    // Always respond success regardless. If the user exists AND has a password
    // (not Google-only), generate a code and email it.
    if (user && user.password_hash) {
      // 6-digit zero-padded code (cryptographically random)
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const codeHash = hashCode(code);
      await pool.query(
        `UPDATE users SET reset_code_hash = $1, reset_code_expires_at = NOW() + INTERVAL '15 minutes'
         WHERE user_id = $2`,
        [codeHash, user.user_id]
      );

      await sendEmail({
        to: email,
        subject: 'Your Sacari password reset code',
        text:
          `Your password reset code is: ${code}\n\n` +
          `It expires in 15 minutes. If you didn't request a reset, you can ignore this email — your password won't change.\n\n` +
          `— Sacari`,
        html:
          `<p>Your password reset code is:</p>` +
          `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${code}</p>` +
          `<p>It expires in 15 minutes. If you didn't request a reset, you can ignore this email — your password won't change.</p>` +
          `<p>— Sacari</p>`,
      });
    }
    // Always success
    return res.json({ success: true });
  } catch {
    // Even on errors, return success so we don't leak existence
    return res.json({ success: true });
  }
});

router.post('/reset', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  if (!rateLimit(`reset:ip:${ip}`, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const email = String(req.body?.email ?? '').toLowerCase().trim();
  const code = String(req.body?.code ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!email || !code || !password) {
    return res.status(400).json({ error: 'email, code, and password required' });
  }
  // Code shape — must be exactly 6 digits
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  if (password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be 6–200 characters' });
  }

  try {
    const codeHash = hashCode(code);
    // Atomic: only flips the password if (email, code) match AND code isn't expired.
    // Returning rowCount tells us whether we actually did something.
    const newHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_code_hash = NULL,
           reset_code_expires_at = NULL
       WHERE email = $2
         AND reset_code_hash = $3
         AND reset_code_expires_at IS NOT NULL
         AND reset_code_expires_at > NOW()
       RETURNING user_id, username, email, elo, total_matches, total_wins, avatar_url, created_at`,
      [newHash, email, codeHash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired code' });

    // On success, also clear any login-throttle bucket for the email so the
    // user can sign in immediately.
    buckets.delete(`login:email:${email}`);

    const user = rows[0];
    return res.json({ token: makeToken(user.user_id), user });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Email verification ──────────────────────────────────────────────────────
//
// Auth-required so we can identify the user without trusting an emailed token.
//   POST /auth/verify-email   { code }    → consume the code, flip email_verified
//   POST /auth/resend-verification        → email a fresh code (keeps existing if still valid)

router.post('/verify-email', requireAuth, async (req: AuthRequest, res: Response) => {
  const ip = clientIp(req);
  if (!rateLimit(`verify:ip:${ip}`, 20, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid or expired code' });

  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    // Atomic flip: only succeeds if (user, code, not-expired) matches.
    const { rows } = await pool.query(
      `UPDATE users
       SET email_verified = TRUE,
           email_verify_code_hash = NULL,
           email_verify_expires_at = NULL
       WHERE user_id = $1
         AND email_verify_code_hash = $2
         AND email_verify_expires_at IS NOT NULL
         AND email_verify_expires_at > NOW()
       RETURNING user_id`,
      [req.userId, codeHash]
    );
    if (!rows.length) {
      // Maybe already verified — surface a useful response either way.
      const { rows: check } = await pool.query(
        `SELECT email_verified FROM users WHERE user_id = $1`, [req.userId]
      );
      if (check[0]?.email_verified) return res.json({ success: true, alreadyVerified: true });
      return res.status(401).json({ error: 'Invalid or expired code' });
    }
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/resend-verification', requireAuth, async (req: AuthRequest, res: Response) => {
  const ip = clientIp(req);
  if (!rateLimit(`verifyresend:ip:${ip}`, 5, 60 * 60 * 1000)
   || !rateLimit(`verifyresend:user:${req.userId}`, 5, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many sends. Try again later.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT email, email_verified FROM users WHERE user_id = $1`,
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (rows[0].email_verified) return res.json({ success: true, alreadyVerified: true });

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    await pool.query(
      `UPDATE users
       SET email_verify_code_hash = $1, email_verify_expires_at = NOW() + INTERVAL '24 hours'
       WHERE user_id = $2`,
      [codeHash, req.userId]
    );

    await sendEmail({
      to: rows[0].email,
      subject: 'Verify your Sacari account',
      text:
        `Your verification code is: ${code}\n\n` +
        `Enter it inside the app to confirm your email. The code expires in 24 hours.\n\n— Sacari`,
      html:
        `<p>Your verification code is:</p>` +
        `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${code}</p>` +
        `<p>Enter it inside the app to confirm your email. The code expires in 24 hours.</p>` +
        `<p>— Sacari</p>`,
    });
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
});

export default router;
