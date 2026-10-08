// The /v1 JSON API. The dashboard uses it with the session cookie; games and agents use it
// with an API key in "Authorization: Bearer <key>":
//   - account keys (jef_acct_…) can do everything the account owner can (billing calls
//     return a Stripe URL for a person to open);
//   - app keys (jef_app_…) work on one app only: moderate, look up / warn / pardon users,
//     and read its rules and history.
// Errors are { error: { code, message } }. Timestamps are ISO 8601 strings.

import express from 'express';
import { config, SEVERITY } from '../config.js';
import { planFor, planLimits, publicPlans, appInPlan } from '../plans.js';
import { webhookUrlProblem, newWebhookSecret } from '../webhooks.js';
import { discordInviteUrl } from '../discord/invite.js';

export const SESSION_COOKIE = 'jef_session';
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const DISCORD_SETTINGS = ['modLogChannelId', 'ignoredChannelIds', 'exemptRoleIds'];

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

export function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null; // a mangled cookie is the same as none
      }
    }
  }
  return null;
}

export const isAdmin = (account) => Boolean(account && config.adminEmails.includes(account.email.toLowerCase()));

// --- How things look over the API ---

export function accountJson(account) {
  return {
    id: account.id, email: account.email, name: account.name, plan: account.plan,
    subscriptionStatus: account.subscriptionStatus, currentPeriodEnd: iso(account.currentPeriodEnd), createdAt: iso(account.createdAt),
  };
}

export function appJson(app, { db, withSecrets = true } = {}) {
  return {
    id: app.id, name: app.name, kind: app.kind, discordGuildId: app.discordGuildId, settings: app.settings,
    webhookUrl: app.webhookUrl, ...(withSecrets ? { webhookSecret: app.webhookSecret } : {}),
    rules: db ? db.rules.list(app.id).map(ruleJson) : undefined,
    // False when the account's plan no longer covers this app (after a downgrade): it isn't moderated.
    inPlan: db ? appInPlan(db, app) : undefined,
    createdAt: iso(app.createdAt),
  };
}

const ruleJson = (r) => ({ id: r.id, text: r.text, severity: r.severity, createdAt: iso(r.createdAt) });
const keyJson = (k) => ({ id: k.id, kind: k.kind, appId: k.appId, name: k.name, prefix: k.prefix, createdAt: iso(k.createdAt), lastUsedAt: iso(k.lastUsedAt) });
const strikeJson = (s) => ({ id: s.id, at: iso(s.at), until: iso(s.until), category: s.category, severity: s.severity, reason: s.reason, excerpt: s.excerpt, by: s.by });
const eventJson = (e) => ({ ...e, at: iso(e.at) });

// --- Input checks ---

const str = (v, name, { max = 200, required = true } = {}) => {
  if (v == null || v === '') {
    if (required) fail(400, 'invalid_request', `${name} is required`);
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, 'invalid_request', `${name} must be a string`);
  const s = String(v).trim();
  if (s.length > max) fail(400, 'invalid_request', `${name} must be at most ${max} characters`);
  return s;
};
const severity = (v, fallback) => {
  if (v == null) return fallback;
  if (!SEVERITY[v]) fail(400, 'invalid_request', `severity must be one of: ${Object.keys(SEVERITY).join(', ')}`);
  return v;
};
const idList = (v, name) => {
  if (!Array.isArray(v) || v.length > 100 || !v.every((x) => /^\d{5,25}$/.test(String(x)))) {
    fail(400, 'invalid_request', `${name} must be a list of Discord IDs`);
  }
  return v.map(String);
};

/**
 * `moderator` is from moderation.js. `rateLimit(app, plan)` returns false when the app is
 * over its requests per second (see server/index.js). Each of `extensions` is called with
 * (router, helpers) to add more /v1 routes (billing does this). `discordWarn(app, warning)`,
 * when the bot is running, carries a warn out on a linked Discord server.
 */
export function createApiRouter({ db, moderator, rateLimit = () => true, extensions = [], discordWarn = null }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // Who's calling: an API key, or the dashboard's session cookie.
  router.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      const key = m && db.keys.verify(m[1]);
      if (!key) return next(new ApiError(401, 'invalid_api_key', 'That API key is not valid'));
      const account = db.accounts.get(key.accountId);
      if (key.kind === 'account' && db.keys.rank(key) >= planFor(account).accountKeys) {
        return next(new ApiError(403, 'plan_limit', `This key is past the ${planFor(account).name} plan's ${planFor(account).accountKeys} account key(s). Use an older key, delete extra keys, or upgrade.`));
      }
      req.auth = { via: key.kind === 'account' ? 'account_key' : 'app_key', key, account, appId: key.appId };
      return next();
    }
    const account = db.sessions.account(readCookie(req, SESSION_COOKIE));
    if (account) {
      // Cookie requests that change things must be same-site JSON, which a form on another site can't send.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && origin !== new URL(config.publicUrl).origin) return next(new ApiError(403, 'bad_origin', 'Cross-site request refused'));
        if (!req.is('application/json')) return next(new ApiError(415, 'json_required', 'Send JSON (Content-Type: application/json)'));
      }
      req.auth = { via: 'session', account };
    }
    next();
  });

  const signedIn = (req) => req.auth ?? fail(401, 'unauthorized', 'Send an API key in the Authorization header, or sign in');
  // Everything except moderation and lookups needs the account itself, not an app key.
  const accountScope = (req) => {
    const auth = signedIn(req);
    if (auth.via === 'app_key') fail(403, 'forbidden', 'App keys can only moderate and read their own app. Use an account key.');
    return auth;
  };
  /** The app in the URL (or body), if the caller may use it. */
  const appFor = (req, appId) => {
    const auth = signedIn(req);
    if (!appId) {
      if (auth.via === 'app_key') appId = auth.appId;
      else fail(400, 'invalid_request', 'appId is required when using an account key');
    }
    const app = db.apps.get(appId);
    if (!app || app.accountId !== auth.account.id || (auth.via === 'app_key' && auth.appId !== app.id)) {
      fail(404, 'not_found', 'No such app');
    }
    return app;
  };
  const ownApp = (req) => {
    accountScope(req);
    return appFor(req, req.params.appId);
  };
  const route = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      next(err);
    }
  };

  // --- Public ---

  router.get('/health', route(() => ({ ok: true })));
  router.get('/plans', route(() => ({ plans: publicPlans() })));

  // --- Account ---

  router.get('/account', route((req) => {
    const { account, via } = signedIn(req);
    const plan = planFor(account);
    return {
      account: accountJson(account),
      limits: planLimits(plan),
      usage: { ...db.usage.get(account.id), apps: db.apps.count(account.id), accountKeys: db.keys.countAccount(account.id) },
      admin: isAdmin(account),
      auth: via,
    };
  }));

  router.get('/keys', route((req) => ({ keys: db.keys.listAccount(accountScope(req).account.id).map(keyJson) })));

  router.post('/keys', route((req, res) => {
    const { account } = accountScope(req);
    const plan = planFor(account);
    if (db.keys.countAccount(account.id) >= plan.accountKeys) {
      fail(403, 'plan_limit', `The ${plan.name} plan allows ${plan.accountKeys} account key(s). Delete one or upgrade.`);
    }
    const { key, secret } = db.keys.create({ accountId: account.id, kind: 'account', name: str(req.body?.name, 'name', { max: 60, required: false }) ?? 'Account key' });
    res.status(201);
    return { key: keyJson(key), secret };
  }));

  router.delete('/keys/:keyId', route((req, res) => {
    const { account } = accountScope(req);
    const key = db.keys.get(req.params.keyId);
    if (!key || key.accountId !== account.id || key.kind !== 'account') fail(404, 'not_found', 'No such key');
    db.keys.delete(key.id);
    res.status(204).end();
  }));

  // --- Apps ---

  router.get('/apps', route((req) => ({ apps: db.apps.list(accountScope(req).account.id).map((a) => appJson(a, { db })) })));

  router.post('/apps', route((req, res) => {
    const { account } = accountScope(req);
    const plan = planFor(account);
    const body = req.body ?? {};
    const name = str(body.name, 'name', { max: 80 });
    const kind = body.kind ?? 'api';
    if (!['api', 'discord'].includes(kind)) fail(400, 'invalid_request', 'kind must be "api" or "discord"');
    if (db.apps.count(account.id) >= plan.apps) fail(403, 'plan_limit', `The ${plan.name} plan allows ${plan.apps} app(s). Delete one or upgrade.`);
    const rules = body.rules ?? [];
    if (!Array.isArray(rules)) fail(400, 'invalid_request', 'rules must be a list of { text, severity }');
    if (rules.length > plan.customRules) fail(403, 'plan_limit', `The ${plan.name} plan allows ${plan.customRules} custom rule(s) per app`);
    const cleanRules = rules.map((r, i) => ({ text: str(r?.text, `rules[${i}].text`, { max: 300 }), severity: severity(r?.severity, 'low') }));
    const webhookUrl = checkWebhookUrl(body.webhookUrl, plan);

    const app = db.transaction(() => {
      const created = db.apps.create({ accountId: account.id, name, kind });
      for (const r of cleanRules) db.rules.add(created.id, r.text, r.severity);
      return webhookUrl ? db.apps.update(created.id, { webhookUrl, webhookSecret: newWebhookSecret() }) : created;
    })();
    const out = { app: appJson(app, { db }) };
    if (kind === 'api' && body.createKey !== false) {
      const { key, secret } = db.keys.create({ accountId: account.id, appId: app.id, kind: 'app', name: 'Default key' });
      out.appKey = { key: keyJson(key), secret };
    }
    if (kind === 'discord') out.discord = discordLink(app);
    res.status(201);
    return out;
  }));

  router.get('/apps/:appId', route((req) => ({ app: appJson(appFor(req, req.params.appId), { db, withSecrets: req.auth?.via !== 'app_key' }) })));

  router.patch('/apps/:appId', route((req) => {
    const app = ownApp(req);
    const plan = planFor(req.auth.account);
    const body = req.body ?? {};
    const patch = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 80 });
    if (body.webhookUrl !== undefined) {
      patch.webhookUrl = checkWebhookUrl(body.webhookUrl, plan);
      if (patch.webhookUrl && !app.webhookSecret) patch.webhookSecret = newWebhookSecret();
    }
    if (body.settings !== undefined) {
      if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) fail(400, 'invalid_request', 'settings must be an object');
      patch.settings = {};
      for (const [k, v] of Object.entries(body.settings)) {
        if (!DISCORD_SETTINGS.includes(k)) fail(400, 'invalid_request', `Unknown setting "${k}". Settings: ${DISCORD_SETTINGS.join(', ')}`);
        if (app.kind !== 'discord') fail(400, 'invalid_request', `${k} only applies to Discord apps`);
        if (v === null) patch.settings[k] = null;
        else if (k === 'modLogChannelId') patch.settings[k] = idList([v], k)[0];
        else patch.settings[k] = idList(v, k);
      }
    }
    return { app: appJson(db.apps.update(app.id, patch), { db }) };
  }));

  router.delete('/apps/:appId', route((req, res) => {
    db.apps.delete(ownApp(req).id);
    res.status(204).end();
  }));

  router.post('/apps/:appId/webhook-secret', route((req) => {
    const app = ownApp(req);
    return { webhookSecret: db.apps.update(app.id, { webhookSecret: newWebhookSecret() }).webhookSecret };
  }));

  function checkWebhookUrl(url, plan) {
    if (url == null || url === '') return null;
    if (!plan.webhooks) fail(403, 'plan_limit', `Webhooks need a paid plan (you're on ${plan.name})`);
    const problem = webhookUrlProblem(String(url), { allowHttp: config.devLogin });
    if (problem) fail(400, 'invalid_request', `webhookUrl ${problem}`);
    return String(url);
  }

  // --- App keys ---

  router.get('/apps/:appId/keys', route((req) => ({ keys: db.keys.listApp(ownApp(req).id).map(keyJson) })));

  router.post('/apps/:appId/keys', route((req, res) => {
    const app = ownApp(req);
    if (app.kind !== 'api') fail(400, 'invalid_request', 'Only API apps have app keys');
    if (db.keys.listApp(app.id).length >= 10) fail(403, 'limit', 'An app can have at most 10 keys');
    const { key, secret } = db.keys.create({ accountId: app.accountId, appId: app.id, kind: 'app', name: str(req.body?.name, 'name', { max: 60, required: false }) ?? 'App key' });
    res.status(201);
    return { key: keyJson(key), secret };
  }));

  router.delete('/apps/:appId/keys/:keyId', route((req, res) => {
    const app = ownApp(req);
    const key = db.keys.get(req.params.keyId);
    if (!key || key.appId !== app.id) fail(404, 'not_found', 'No such key');
    db.keys.delete(key.id);
    res.status(204).end();
  }));

  // --- Discord linking ---

  function discordLink(app) {
    const { code, expiresAt } = db.discordLinks.create(app.id);
    return {
      inviteUrl: discordInviteUrl(code),
      linkCode: code,
      linkCommand: `/jef link code:${code}`,
      expiresAt: iso(expiresAt),
      autoLink: Boolean(config.discordClientSecret),
    };
  }

  router.post('/apps/:appId/discord/link', route((req) => {
    const app = ownApp(req);
    if (app.kind !== 'discord') fail(400, 'invalid_request', 'Only Discord apps link to a Discord server');
    return discordLink(app);
  }));

  router.delete('/apps/:appId/discord', route((req, res) => {
    const app = ownApp(req);
    db.apps.setGuild(app.id, null);
    res.status(204).end();
  }));

  // --- Custom rules ---

  router.get('/apps/:appId/rules', route((req) => ({ rules: db.rules.list(appFor(req, req.params.appId).id).map(ruleJson) })));

  router.post('/apps/:appId/rules', route((req, res) => {
    const app = ownApp(req);
    const plan = planFor(req.auth.account);
    if (db.rules.count(app.id) >= plan.customRules) fail(403, 'plan_limit', `The ${plan.name} plan allows ${plan.customRules} custom rule(s) per app`);
    const rule = db.rules.add(app.id, str(req.body?.text, 'text', { max: 300 }), severity(req.body?.severity, 'low'));
    res.status(201);
    return { rule: ruleJson(rule) };
  }));

  router.delete('/apps/:appId/rules/:ruleId', route((req, res) => {
    const app = ownApp(req);
    if (!db.rules.remove(app.id, Number(req.params.ruleId))) fail(404, 'not_found', 'No such rule');
    res.status(204).end();
  }));

  // --- Moderation ---

  router.post('/moderate', route(async (req, res) => {
    const body = req.body ?? {};
    const app = appFor(req, body.appId);
    const account = req.auth.account;
    if (!appInPlan(db, app, account)) {
      fail(403, 'plan_limit', `The ${planFor(account).name} plan covers ${planFor(account).apps} app(s) and this one is past that, so it isn't moderated. Delete an app or upgrade.`);
    }
    if (!rateLimit(app, planFor(account))) {
      res.set('Retry-After', '1');
      fail(429, 'rate_limited', 'Too many requests for this app; slow down');
    }
    const context = body.context == null ? undefined : body.context;
    if (context !== undefined && (!Array.isArray(context) || context.length > 20)) fail(400, 'invalid_request', 'context must be a list of up to 20 earlier messages');
    const replyTo = body.replyTo == null ? null
      : typeof body.replyTo === 'object' ? `${str(body.replyTo.username, 'replyTo.username', { max: 100, required: false }) ?? 'someone'}: ${str(body.replyTo.text, 'replyTo.text', { max: 300, required: false }) ?? ''}`
        : str(body.replyTo, 'replyTo', { max: 400 });
    return moderator.moderate(app, {
      userId: str(body.userId, 'userId', { max: 100 }),
      username: str(body.username, 'username', { max: 100, required: false }),
      text: str(body.text, 'text', { max: 4000 }),
      messageId: str(body.messageId, 'messageId', { max: 100, required: false }),
      room: str(body.room, 'room', { max: 100, required: false }),
      replyTo,
      context: context?.map((c, i) => (typeof c === 'string'
        ? str(c, `context[${i}]`, { max: 400 })
        : `${str(c?.username, `context[${i}].username`, { max: 100, required: false }) ?? 'someone'}: ${str(c?.text, `context[${i}].text`, { max: 300 })}`)),
    });
  }));

  // --- Users (strikes) ---

  const standingJson = (s) => ({ ...s, active: s.active.map(strikeJson) });

  router.get('/apps/:appId/users/:userId', route((req) => standingJson(moderator.standing(appFor(req, req.params.appId), req.params.userId))));

  router.post('/apps/:appId/users/:userId/warn', route(async (req) => {
    const app = appFor(req, req.params.appId);
    const by = str(req.body?.by, 'by', { max: 100, required: false }) ?? (req.auth.via === 'session' ? req.auth.account.email : req.auth.key.name);
    const warning = {
      userId: req.params.userId,
      username: str(req.body?.username, 'username', { max: 100, required: false }),
      reason: str(req.body?.reason, 'reason', { max: 300 }),
      severity: severity(req.body?.severity, 'medium'),
      by,
    };
    const out = moderator.warn(app, warning);
    // On a linked Discord server the bot carries it out; API apps apply `action` themselves.
    if (app.kind === 'discord' && app.discordGuildId && discordWarn) {
      out.discordOutcome = await discordWarn(app, { ...warning, ...out }).catch((err) => {
        console.error('[api] Discord warn failed', err);
        return null;
      });
    }
    return out;
  }));

  router.post('/apps/:appId/users/:userId/pardon', route((req) => {
    const app = appFor(req, req.params.appId);
    const count = req.body?.count;
    if (count != null && !(Number.isInteger(count) && count > 0)) fail(400, 'invalid_request', 'count must be a positive whole number');
    const by = str(req.body?.by, 'by', { max: 100, required: false }) ?? (req.auth.via === 'session' ? req.auth.account.email : req.auth.key.name);
    return moderator.pardon(app, { userId: req.params.userId, count, by });
  }));

  // --- History ---

  router.get('/apps/:appId/events', route((req) => {
    const app = appFor(req, req.params.appId);
    const limit = Number(req.query.limit ?? 50);
    const before = req.query.before == null ? null : Number(req.query.before);
    if (!Number.isInteger(limit) || (before !== null && !Number.isInteger(before))) fail(400, 'invalid_request', 'limit and before must be whole numbers');
    const userId = req.query.userId == null ? null : str(req.query.userId, 'userId', { max: 100 });
    const events = db.events.list(app.id, { limit, before, userId }).map(eventJson);
    return { events, nextBefore: events.length ? events.at(-1).id : null };
  }));

  for (const extend of extensions) extend(router, { db, route, signedIn, accountScope, appFor, fail, ApiError });

  router.use((req, res, next) => next(new ApiError(404, 'not_found', `No such endpoint: ${req.method} /v1${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'The body is not valid JSON' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'The body is too large' } });
    if (err.code === 'guild_taken') return res.status(409).json({ error: { code: 'guild_taken', message: err.message } });
    console.error('[api]', err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side' } });
  });

  return router;
}
