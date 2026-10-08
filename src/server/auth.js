// Signing in to the dashboard: Google OAuth 2.0 (authorization code + PKCE), sign-out, and a
// dev-only sign-in for local testing. A signed-in browser carries the `jef_session` cookie,
// which the /v1 API accepts (see api.js).

import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { SESSION_COOKIE, readCookie } from './api.js';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

// Holds the OAuth state, PKCE verifier and where to go afterwards, between /google and /callback.
const FLOW_COOKIE = 'jef_oauth';
const FLOW_TTL_S = 10 * 60;
const SESSION_TTL_S = 30 * 24 * 60 * 60;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const googleConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
const secure = () => config.publicUrl.startsWith('https:');

/** Only dashboard paths, so a crafted link can't send people elsewhere after signing in. */
export function safeNext(next) {
  if (typeof next !== 'string' || next.length > 500) return '/app';
  if (!/^\/app(?:[/?#]|$)/.test(next)) return '/app';
  if (next.includes('//') || next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) return '/app';
  return next;
}

function cookie(name, value, { maxAge, path = '/' }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure()) parts.push('Secure');
  return parts.join('; ');
}

const sameString = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Fixed-window request counter per IP. */
function rateLimiter({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [ip, h] of hits) if (h.reset < t) hits.delete(ip);
    const ip = req.ip ?? 'unknown';
    let h = hits.get(ip);
    if (!h || h.reset < t) hits.set(ip, (h = { count: 0, reset: t + windowMs }));
    if (++h.count > limit) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).type('text/plain').send('Too many sign-in attempts. Wait a minute and try again.');
    }
    next();
  };
}

/**
 * `fetchImpl` is for tests (Google is never called from tests). `rateLimit` is requests per
 * minute per IP across /auth.
 */
export function createAuthRouter({ db, fetchImpl = fetch, rateLimit = 60 }) {
  const router = express.Router();
  router.use(rateLimiter({ limit: rateLimit }));

  const startSession = (res, account, next) => {
    const token = db.sessions.create(account.id, SESSION_TTL_S * 1000);
    res.append('Set-Cookie', cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_S }));
    res.redirect(303, safeNext(next));
  };
  const failTo = (res, code) => res.redirect(303, `/app/login?error=${encodeURIComponent(code)}`);

  // What the sign-in page should offer.
  router.get('/config', (req, res) => res.json({ google: googleConfigured(), dev: config.devLogin }));

  // --- Google ---

  router.get('/google', (req, res) => {
    if (!googleConfigured()) {
      res.status(503);
      if (req.accepts(['html', 'json']) === 'json') return res.json({ error: { code: 'google_unavailable', message: 'Google sign-in is not configured' } });
      return res.type('html').send('<!doctype html><meta charset="utf-8"><title>Sign-in unavailable</title><p>Google sign-in isn\'t set up on this server yet. <a href="/app/login">Back</a></p>');
    }
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const flow = b64url(JSON.stringify({ state, verifier, next: safeNext(req.query.next) }));
    res.append('Set-Cookie', cookie(FLOW_COOKIE, flow, { maxAge: FLOW_TTL_S, path: '/auth' }));
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.publicUrl}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(302, `${GOOGLE_AUTHORIZE}?${params}`);
  });

  router.get('/google/callback', async (req, res) => {
    // The flow cookie is single-use.
    res.append('Set-Cookie', cookie(FLOW_COOKIE, '', { maxAge: 0, path: '/auth' }));
    if (!googleConfigured()) return failTo(res, 'google_unavailable');
    if (req.query.error) return failTo(res, 'denied');

    let flow;
    try {
      flow = JSON.parse(Buffer.from(readCookie(req, FLOW_COOKIE) ?? '', 'base64url').toString());
    } catch {
      flow = null;
    }
    if (!flow || !sameString(flow.state, req.query.state)) return failTo(res, 'state');
    if (typeof req.query.code !== 'string' || !req.query.code) return failTo(res, 'failed');

    try {
      const tokenRes = await fetchImpl(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: `${config.publicUrl}/auth/google/callback`,
          grant_type: 'authorization_code',
          code_verifier: String(flow.verifier ?? ''),
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const tokens = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokens.access_token) {
        console.warn('[auth] Google token exchange failed:', tokenRes.status, tokens.error ?? '');
        return failTo(res, 'exchange');
      }

      const infoRes = await fetchImpl(GOOGLE_USERINFO, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const info = await infoRes.json().catch(() => ({}));
      if (!infoRes.ok || !info.sub || !info.email) return failTo(res, 'exchange');
      if (info.email_verified !== true && info.email_verified !== 'true') return failTo(res, 'unverified');

      let account;
      try {
        account = db.accounts.upsertGoogle({ sub: String(info.sub), email: String(info.email).toLowerCase(), name: info.name ? String(info.name).slice(0, 100) : null });
      } catch {
        // The email is already tied to a different Google account.
        return failTo(res, 'email_conflict');
      }
      startSession(res, account, flow.next);
    } catch (err) {
      console.warn('[auth] Google sign-in failed:', err.message);
      failTo(res, 'failed');
    }
  });

  // --- Sign out ---

  router.post('/logout', (req, res) => {
    // Only from our own pages (a form elsewhere could otherwise sign people out).
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.publicUrl).origin) return res.status(403).type('text/plain').send('Cross-site request refused');
    db.sessions.delete(readCookie(req, SESSION_COOKIE));
    res.append('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 }));
    if (req.is('application/x-www-form-urlencoded') || req.is('multipart/form-data')) return res.redirect(303, '/app/login');
    res.status(204).end();
  });

  // --- Dev sign-in (local testing only) ---

  router.get('/dev', (req, res) => {
    if (!config.devLogin) return res.status(404).type('text/plain').send('Not found');
    // A link or image on another site mustn't be able to sign someone in.
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).type('text/plain').send('Cross-site sign-in refused');
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return failTo(res, 'bad_email');
    const account = db.accounts.byEmail(email) ?? db.accounts.create({ email, name: email.split('@')[0] });
    startSession(res, account, req.query.next);
  });

  return router;
}
