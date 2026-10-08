// The web server: the public site and docs (docs/), the dashboard (docs/app/), the /v1 API,
// Google sign-in (/auth), Stripe (/webhooks/stripe) and Discord's "Add to server" callback.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { createApiRouter } from './api.js';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

/** Token bucket per app: `plan.requestsPerSecond`, bursts up to twice that. */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  return (app, plan) => {
    const rate = plan.requestsPerSecond;
    const t = now();
    const b = buckets.get(app.id) ?? { tokens: rate * 2, at: t };
    b.tokens = Math.min(rate * 2, b.tokens + ((t - b.at) / 1000) * rate);
    b.at = t;
    buckets.set(app.id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/**
 * `routers`: [{ path, router }] mounted before the API (auth, Stripe webhook, Discord callback).
 * `apiExtensions`: extra /v1 routes and `discordWarn` (see api.js).
 */
export function createServer({ db, moderator, routers = [], apiExtensions = [], rateLimit = createRateLimiter(), discordWarn = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    if (config.publicUrl.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Games call the API from their own servers, but browsers on other sites may call it with a
  // key too (never with the cookie: credentials aren't allowed cross-origin).
  app.use('/v1', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.headers.origin && req.headers.origin !== new URL(config.publicUrl).origin && !req.headers.authorization) {
      // A cross-site request riding on the session cookie: treat it as signed out.
      delete req.headers.cookie;
    }
    next();
  });

  for (const r of routers) app.use(r.path, r.router);
  app.use('/v1', createApiRouter({ db, moderator, rateLimit, extensions: apiExtensions, discordWarn }));

  // The dashboard is a single page: /app and any /app/... path that isn't one of its files serves it.
  app.get(/^\/app(\/[^.]*)?$/, (req, res) => res.sendFile(path.join(SITE_DIR, 'app', 'index.html')));
  app.use(express.static(SITE_DIR, { extensions: ['html'], index: 'index.html' }));
  app.use((req, res) => res.status(404).sendFile(path.join(SITE_DIR, '404.html'), (err) => err && res.end()));

  return app;
}
