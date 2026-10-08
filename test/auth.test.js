import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server/index.js';
import { createAuthRouter, safeNext } from '../src/server/auth.js';

// Never talk to Google: every request goes to this fake.
const google = { email: 'ana@example.com', verified: true, sub: 'google-sub-1', tokenOk: true, calls: [] };
async function fakeFetch(url, init = {}) {
  google.calls.push({ url: String(url), init });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    return google.tokenOk ? json(200, { access_token: 'at-123', token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' });
  }
  if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') {
    assert.equal(init.headers.Authorization, 'Bearer at-123');
    return json(200, { sub: google.sub, email: google.email, email_verified: google.verified, name: 'Ana' });
  }
  throw new Error(`unexpected fetch ${url}`);
}

const stubModerator = { moderate: async () => ({}), warn: () => ({}), pardon: () => ({}), standing: () => ({}) };
let db;
let server;
let base;

before(async () => {
  config.googleClientId = 'client-id';
  config.googleClientSecret = 'client-secret';
  config.devLogin = false;
  db = openDb(':memory:');
  const app = createServer({ db, moderator: stubModerator, routers: [{ path: '/auth', router: createAuthRouter({ db, fetchImpl: fakeFetch }) }] });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
});

const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });
const cookiesOf = (res) => Object.fromEntries(res.headers.getSetCookie().map((c) => {
  const [pair] = c.split(';');
  const i = pair.indexOf('=');
  return [pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))];
}));

/** Start the Google flow; returns the state Google would echo back and the flow cookie. */
async function startFlow(next) {
  const res = await get(`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.equal(loc.searchParams.get('redirect_uri'), `${config.publicUrl}/auth/google/callback`);
  const flow = cookiesOf(res).jef_oauth;
  assert.ok(flow);
  return { state: loc.searchParams.get('state'), cookie: `jef_oauth=${encodeURIComponent(flow)}` };
}

test('safeNext only allows dashboard paths', () => {
  assert.equal(safeNext('/app/apps/x?tab=rules'), '/app/apps/x?tab=rules');
  assert.equal(safeNext('/app'), '/app');
  for (const bad of ['https://evil.example', '//evil.example', '/application', '/app//evil', '/app/\\evil', '/v1/keys', undefined, ['/app']]) {
    assert.equal(safeNext(bad), '/app', String(bad));
  }
});

test('/auth/config reports what is available', async () => {
  const res = await get('/auth/config');
  assert.deepEqual(await res.json(), { google: true, dev: false });
});

test('a state mismatch is rejected', async () => {
  const { cookie } = await startFlow();
  google.calls = [];
  const res = await get('/auth/google/callback?code=abc&state=wrong', { cookie });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/app/login?error=state');
  assert.equal(google.calls.length, 0);
  // No flow cookie at all is rejected too.
  const res2 = await get('/auth/google/callback?code=abc&state=x');
  assert.equal(res2.headers.get('location'), '/app/login?error=state');
});

test('a successful callback creates the account and a session', async () => {
  google.calls = [];
  const { state, cookie } = await startFlow('/app/apps/123');
  const res = await get(`/auth/google/callback?code=the-code&state=${state}`, { cookie });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/app/apps/123');

  const tokenCall = google.calls.find((c) => c.url.includes('oauth2.googleapis.com'));
  const body = new URLSearchParams(tokenCall.init.body);
  assert.equal(body.get('code'), 'the-code');
  assert.ok(body.get('code_verifier').length >= 43);

  const raw = res.headers.getSetCookie().find((c) => c.startsWith('jef_session='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Max-Age=2592000/);
  const token = cookiesOf(res).jef_session;
  const account = db.sessions.account(token);
  assert.equal(account.email, 'ana@example.com');
  assert.equal(account.googleSub, 'google-sub-1');

  const me = await (await get('/v1/account', { cookie: `jef_session=${token}` })).json();
  assert.equal(me.account.email, 'ana@example.com');
  assert.equal(me.auth, 'session');
});

test('an unverified email is rejected', async () => {
  google.verified = false;
  google.sub = 'google-sub-2';
  google.email = 'bob@example.com';
  try {
    const { state, cookie } = await startFlow();
    const res = await get(`/auth/google/callback?code=c&state=${state}`, { cookie });
    assert.equal(res.headers.get('location'), '/app/login?error=unverified');
    assert.equal(cookiesOf(res).jef_session, undefined);
    assert.equal(db.accounts.byEmail('bob@example.com'), null);
  } finally {
    google.verified = true;
  }
});

test('a failed token exchange and an email conflict are friendly errors', async () => {
  google.tokenOk = false;
  let { state, cookie } = await startFlow();
  let res = await get(`/auth/google/callback?code=c&state=${state}`, { cookie });
  assert.equal(res.headers.get('location'), '/app/login?error=exchange');
  google.tokenOk = true;

  // ana@example.com already belongs to google-sub-1.
  google.sub = 'google-sub-3';
  google.email = 'ana@example.com';
  ({ state, cookie } = await startFlow());
  res = await get(`/auth/google/callback?code=c&state=${state}`, { cookie });
  assert.equal(res.headers.get('location'), '/app/login?error=email_conflict');
  google.sub = 'google-sub-1';
});

test('an unsafe next is ignored', async () => {
  google.sub = 'google-sub-1';
  google.email = 'ana@example.com';
  const { state, cookie } = await startFlow('https://evil.example/steal');
  const res = await get(`/auth/google/callback?code=c&state=${state}`, { cookie });
  assert.equal(res.headers.get('location'), '/app');
});

test('Google sign-in is 503 when not configured', async () => {
  config.googleClientId = null;
  try {
    const res = await get('/auth/google', { accept: 'application/json' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'google_unavailable');
    assert.equal((await (await get('/auth/config')).json()).google, false);
  } finally {
    config.googleClientId = 'client-id';
  }
});

test('dev sign-in only works when enabled', async () => {
  assert.equal((await get('/auth/dev?email=dev@example.com')).status, 404);
  config.devLogin = true;
  try {
    const res = await get('/auth/dev?email=Dev@Example.com&next=/app/account');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/app/account');
    const account = db.sessions.account(cookiesOf(res).jef_session);
    assert.equal(account.email, 'dev@example.com');
    assert.equal(account.googleSub, null);
    assert.equal((await get('/auth/dev?email=nope')).headers.get('location'), '/app/login?error=bad_email');
  } finally {
    config.devLogin = false;
  }
});

test('logout ends the session', async () => {
  const token = db.sessions.create(db.accounts.byEmail('ana@example.com').id);
  const cookie = `jef_session=${token}`;
  assert.equal((await get('/v1/account', { cookie })).status, 200);

  const refused = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(refused.status, 403);
  assert.ok(db.sessions.account(token));

  const res = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' } });
  assert.equal(res.status, 204);
  assert.match(res.headers.getSetCookie().find((c) => c.startsWith('jef_session=')), /Max-Age=0/);
  assert.equal(db.sessions.account(token), null);
  assert.equal((await get('/v1/account', { cookie })).status, 401);

  // A plain form post is sent back to the sign-in page.
  const form = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), '/app/login');
});

test('/auth is rate limited per IP', async () => {
  const limitedDb = openDb(':memory:');
  const app = createServer({ db: limitedDb, moderator: stubModerator, routers: [{ path: '/auth', router: createAuthRouter({ db: limitedDb, fetchImpl: fakeFetch, rateLimit: 3 }) }] });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const url = `http://127.0.0.1:${s.address().port}/auth/config`;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(url)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    s.close();
    limitedDb.close();
  }
});
