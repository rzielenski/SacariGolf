/**
 * Auth helpers for the web app. The website is a client of the existing backend
 * API: it logs in there, keeps the returned JWT in a secure httpOnly cookie,
 * and calls the same authenticated endpoints the mobile app uses. No tokens are
 * ever exposed to browser JavaScript.
 */
'use strict';

const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const COOKIE = 'sg_token';

async function backendLogin(email, password) {
  const r = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Invalid email or password');
  return data; // { token, user }
}

async function backendRegister(username, email, password) {
  const r = await fetch(`${BACKEND_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Could not create your account');
  return data; // { token, user }
}

async function apiGet(path, token) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const err = new Error(`api ${r.status}`);
    err.code = r.status;
    throw err;
  }
  return r.json();
}

/** Best-effort fetch: returns null instead of throwing, so one failing widget
 *  does not blank the whole page. */
async function apiGetSafe(path, token) {
  try { return await apiGet(path, token); }
  catch { return null; }
}

async function apiPost(path, token, body) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `api ${r.status}`);
    err.code = r.status;
    throw err;
  }
  return data;
}

function setSession(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Gate for authenticated pages. Redirects to /login when no session. */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) { res.redirect('/login'); return; }
  req.token = token;
  next();
}

module.exports = { backendLogin, backendRegister, apiGet, apiGetSafe, apiPost, setSession, clearSession, requireAuth, COOKIE };
