// SQLite storage for everything Jef Bot keeps: accounts, sessions, API keys, apps
// (a Discord server or an API app), custom rules, strikes, moderation history and usage.
// Uses Node's built-in node:sqlite, so there's nothing native to compile.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;
// Strike records are deleted this long after they stop counting.
const KEEP_EXPIRED_STRIKES_MS = 30 * DAY_MS;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  google_sub TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  current_period_end INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discord', 'api')),
  discord_guild_id TEXT UNIQUE,
  settings TEXT NOT NULL DEFAULT '{}',
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at INTEGER NOT NULL
);

-- kind 'account': full access to the account. kind 'app': only that app.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'app')),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  until INTEGER NOT NULL,
  category TEXT,
  severity TEXT,
  reason TEXT,
  excerpt TEXT,
  by TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS strikes_user ON strikes (app_id, user_id, until);

-- Moderation history: every action and "watching" note, shown in the dashboard.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  room TEXT,
  message_id TEXT,
  excerpt TEXT,
  category TEXT,
  severity TEXT,
  reason TEXT,
  source TEXT,
  action TEXT,
  strikes INTEGER,
  by TEXT
);
CREATE INDEX IF NOT EXISTS events_app ON events (app_id, id);

CREATE TABLE IF NOT EXISTS usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  ai_checks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE IF NOT EXISTS discord_links (
  code TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomId = (prefix, bytes = 9) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
export const month = (ms) => new Date(ms).toISOString().slice(0, 7);

function toAccount(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, name: row.name, googleSub: row.google_sub, plan: row.plan,
    stripeCustomerId: row.stripe_customer_id, stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status, currentPeriodEnd: row.current_period_end, createdAt: row.created_at,
  };
}

function toApp(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, name: row.name, kind: row.kind, discordGuildId: row.discord_guild_id,
    settings: JSON.parse(row.settings), webhookUrl: row.webhook_url, webhookSecret: row.webhook_secret, createdAt: row.created_at,
  };
}

function toKey(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, appId: row.app_id, kind: row.kind, name: row.name,
    prefix: row.prefix, createdAt: row.created_at, lastUsedAt: row.last_used_at,
  };
}

function toEvent(row) {
  return {
    id: row.id, at: row.at, type: row.type, userId: row.user_id, username: row.username, room: row.room,
    messageId: row.message_id, excerpt: row.excerpt, category: row.category, severity: row.severity,
    reason: row.reason, source: row.source, action: row.action, strikes: row.strikes, by: row.by,
  };
}

const toStrike = (row) => ({
  id: row.id, at: row.at, until: row.until, category: row.category, severity: row.severity,
  reason: row.reason, excerpt: row.excerpt, by: row.by,
});

/** Open (and create or upgrade) the database. `file` ':memory:' is for tests. */
export function openDb(file, { now = () => Date.now() } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const api = {
    raw: db,
    now,
    close: () => db.close(),
    transaction: tx,

    meta: {
      get: (key) => q('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
      set: (key, value) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
    },

    accounts: {
      get: (id) => toAccount(q('SELECT * FROM accounts WHERE id = ?').get(id)),
      byEmail: (email) => toAccount(q('SELECT * FROM accounts WHERE email = ?').get(email)),
      byGoogleSub: (sub) => toAccount(q('SELECT * FROM accounts WHERE google_sub = ?').get(sub)),
      byStripeCustomer: (id) => toAccount(q('SELECT * FROM accounts WHERE stripe_customer_id = ?').get(id)),
      create({ email, name = null, googleSub = null, plan = 'free' }) {
        const id = randomId('acct');
        q('INSERT INTO accounts (id, email, name, google_sub, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, email, name, googleSub, plan, now());
        return api.accounts.get(id);
      },
      /** Find the account for a Google sign-in, creating it (or claiming a pre-made one by email). */
      upsertGoogle({ sub, email, name }) {
        const bySub = api.accounts.byGoogleSub(sub);
        if (bySub) {
          q('UPDATE accounts SET email = ?, name = COALESCE(?, name) WHERE id = ?').run(email, name, bySub.id);
          return api.accounts.get(bySub.id);
        }
        const byEmail = api.accounts.byEmail(email);
        if (byEmail && !byEmail.googleSub) {
          q('UPDATE accounts SET google_sub = ?, name = COALESCE(?, name) WHERE id = ?').run(sub, name, byEmail.id);
          return api.accounts.get(byEmail.id);
        }
        if (byEmail) throw new Error('That email belongs to a different Google account');
        return api.accounts.create({ email, name, googleSub: sub });
      },
      /** Update billing fields; any key left undefined is unchanged. */
      setBilling(id, { plan, stripeCustomerId, stripeSubscriptionId, subscriptionStatus, currentPeriodEnd }) {
        const cur = api.accounts.get(id);
        if (!cur) return null;
        const pick = (v, old) => (v === undefined ? old : v);
        q(`UPDATE accounts SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
           subscription_status = ?, current_period_end = ? WHERE id = ?`).run(
          pick(plan, cur.plan), pick(stripeCustomerId, cur.stripeCustomerId), pick(stripeSubscriptionId, cur.stripeSubscriptionId),
          pick(subscriptionStatus, cur.subscriptionStatus), pick(currentPeriodEnd, cur.currentPeriodEnd), id,
        );
        return api.accounts.get(id);
      },
      delete: (id) => q('DELETE FROM accounts WHERE id = ?').run(id),
    },

    sessions: {
      /** Returns the raw token for the cookie; only its hash is stored. */
      create(accountId, ttlMs = 30 * DAY_MS) {
        const token = crypto.randomBytes(32).toString('base64url');
        q('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
          .run(sha256(token), accountId, now(), now() + ttlMs);
        return token;
      },
      account(token) {
        if (!token) return null;
        const row = q('SELECT account_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
        if (!row || row.expires_at < now()) return null;
        return api.accounts.get(row.account_id);
      },
      delete: (token) => q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token ?? '')),
      prune: () => q('DELETE FROM sessions WHERE expires_at < ?').run(now()),
    },

    keys: {
      /** Create a key. Returns { key, secret }; the secret is only ever shown this once. */
      create({ accountId, appId = null, kind, name }) {
        const head = kind === 'account' ? 'jef_acct_' : 'jef_app_';
        const secret = head + crypto.randomBytes(24).toString('base64url');
        const id = randomId('key');
        q(`INSERT INTO api_keys (id, account_id, app_id, kind, name, prefix, key_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, accountId, appId, kind, name, secret.slice(0, head.length + 4), sha256(secret), now());
        return { key: api.keys.get(id), secret };
      },
      get: (id) => toKey(q('SELECT * FROM api_keys WHERE id = ?').get(id)),
      /** Look up a presented secret; records when it was last used (at most once a minute). */
      verify(secret) {
        if (!secret) return null;
        const row = q('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(secret));
        if (!row) return null;
        if (!row.last_used_at || now() - row.last_used_at > 60_000) {
          q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
        }
        return toKey(row);
      },
      listAccount: (accountId) => q("SELECT * FROM api_keys WHERE account_id = ? AND kind = 'account' ORDER BY created_at").all(accountId).map(toKey),
      listApp: (appId) => q("SELECT * FROM api_keys WHERE app_id = ? AND kind = 'app' ORDER BY created_at").all(appId).map(toKey),
      countAccount: (accountId) => q("SELECT COUNT(*) n FROM api_keys WHERE account_id = ? AND kind = 'account'").get(accountId).n,
      /** How many of the account's account keys are older than this one. */
      rank: (key) => q("SELECT COUNT(*) n FROM api_keys WHERE account_id = ? AND kind = 'account' AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM api_keys WHERE id = ?)))")
        .get(key.accountId, key.createdAt, key.createdAt, key.id).n,
      delete: (id) => q('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0,
    },

    apps: {
      create({ accountId, name, kind, settings = {} }) {
        const id = randomId('app');
        q('INSERT INTO apps (id, account_id, name, kind, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, accountId, name, kind, JSON.stringify(settings), now());
        return api.apps.get(id);
      },
      get: (id) => toApp(q('SELECT * FROM apps WHERE id = ?').get(id)),
      byGuild: (guildId) => toApp(q('SELECT * FROM apps WHERE discord_guild_id = ?').get(guildId)),
      list: (accountId) => q('SELECT * FROM apps WHERE account_id = ? ORDER BY created_at').all(accountId).map(toApp),
      /** Every app linked to a Discord server. */
      linked: () => q('SELECT * FROM apps WHERE discord_guild_id IS NOT NULL').all().map(toApp),
      count: (accountId) => q('SELECT COUNT(*) n FROM apps WHERE account_id = ?').get(accountId).n,
      /** How many of the account's apps are older than this one (0 = its first app). */
      rank: (app) => q('SELECT COUNT(*) n FROM apps WHERE account_id = ? AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM apps WHERE id = ?)))')
        .get(app.accountId, app.createdAt, app.createdAt, app.id).n,
      /** Change name, settings (merged; null removes a key), webhook URL/secret. */
      update(id, { name, settings, webhookUrl, webhookSecret }) {
        const cur = api.apps.get(id);
        if (!cur) return null;
        const merged = { ...cur.settings };
        for (const [k, v] of Object.entries(settings ?? {})) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        q('UPDATE apps SET name = ?, settings = ?, webhook_url = ?, webhook_secret = ? WHERE id = ?').run(
          name ?? cur.name, JSON.stringify(merged),
          webhookUrl === undefined ? cur.webhookUrl : webhookUrl,
          webhookSecret === undefined ? cur.webhookSecret : webhookSecret, id,
        );
        return api.apps.get(id);
      },
      /** Link a Discord server to this app (null unlinks). Throws if another app has it. */
      setGuild(id, guildId) {
        const other = guildId && api.apps.byGuild(guildId);
        if (other && other.id !== id) {
          const err = new Error('That Discord server is already linked to another app');
          err.code = 'guild_taken';
          throw err;
        }
        q('UPDATE apps SET discord_guild_id = ? WHERE id = ?').run(guildId, id);
        return api.apps.get(id);
      },
      delete: (id) => q('DELETE FROM apps WHERE id = ?').run(id).changes > 0,
    },

    rules: {
      list: (appId) => q('SELECT id, text, severity, created_at FROM rules WHERE app_id = ? ORDER BY id').all(appId)
        .map((r) => ({ id: r.id, text: r.text, severity: r.severity, createdAt: r.created_at })),
      count: (appId) => q('SELECT COUNT(*) n FROM rules WHERE app_id = ?').get(appId).n,
      add(appId, text, severity) {
        const { lastInsertRowid } = q('INSERT INTO rules (app_id, text, severity, created_at) VALUES (?, ?, ?, ?)')
          .run(appId, text, severity, now());
        return { id: Number(lastInsertRowid), text, severity, createdAt: now() };
      },
      /** Removes and returns the rule, or null. */
      remove(appId, ruleId) {
        const row = q('SELECT id, text, severity FROM rules WHERE app_id = ? AND id = ?').get(appId, ruleId);
        if (!row) return null;
        q('DELETE FROM rules WHERE id = ?').run(row.id);
        return { id: row.id, text: row.text, severity: row.severity };
      },
    },

    strikes: {
      /** Strikes that still count toward the punishment ladder, oldest first. */
      active: (appId, userId) => q('SELECT * FROM strikes WHERE app_id = ? AND user_id = ? AND until > ? ORDER BY at, id')
        .all(appId, String(userId), now()).map(toStrike),
      count: (appId, userId) => q('SELECT COUNT(*) n FROM strikes WHERE app_id = ? AND user_id = ? AND until > ?')
        .get(appId, String(userId), now()).n,
      /** Record an offense that counts for `cooldownMs`; returns the new active count. */
      add(appId, userId, { category, severity, reason, excerpt, cooldownMs = DAY_MS, by = 'auto', at = now() }) {
        q('INSERT INTO strikes (app_id, user_id, at, until, category, severity, reason, excerpt, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(appId, String(userId), at, at + cooldownMs, category ?? null, severity ?? null, reason ?? null, excerpt?.slice(0, 200) ?? null, by);
        return api.strikes.count(appId, userId);
      },
      /** Remove the most recent `n` active strikes (all when omitted). Returns how many were removed. */
      pardon(appId, userId, n) {
        const ids = q('SELECT id FROM strikes WHERE app_id = ? AND user_id = ? AND until > ? ORDER BY at DESC, id DESC')
          .all(appId, String(userId), now()).map((r) => r.id);
        const remove = n == null ? ids : ids.slice(0, n);
        for (const id of remove) q('DELETE FROM strikes WHERE id = ?').run(id);
        return remove.length;
      },
      forgetApp: (appId) => q('DELETE FROM strikes WHERE app_id = ?').run(appId),
      prune: () => q('DELETE FROM strikes WHERE until < ?').run(now() - KEEP_EXPIRED_STRIKES_MS),
    },

    events: {
      add(appId, e) {
        const { lastInsertRowid } = q(`INSERT INTO events (app_id, at, type, user_id, username, room, message_id, excerpt,
          category, severity, reason, source, action, strikes, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          appId, e.at ?? now(), e.type, e.userId == null ? null : String(e.userId), e.username ?? null, e.room ?? null,
          e.messageId == null ? null : String(e.messageId), e.excerpt?.slice(0, 500) ?? null, e.category ?? null,
          e.severity ?? null, e.reason ?? null, e.source ?? null, e.action ?? null, e.strikes ?? null, e.by ?? null,
        );
        return Number(lastInsertRowid);
      },
      /** Newest first. `before` is an event id for paging; `userId` filters to one user. */
      list(appId, { limit = 50, before = null, userId = null } = {}) {
        return q(`SELECT * FROM events WHERE app_id = ? AND (? IS NULL OR id < ?) AND (? IS NULL OR user_id = ?)
                  ORDER BY id DESC LIMIT ?`)
          .all(appId, before, before, userId, userId == null ? null : String(userId), Math.min(Math.max(limit, 1), 200)).map(toEvent);
      },
      forgetApp: (appId) => q('DELETE FROM events WHERE app_id = ?').run(appId),
      /** Delete each app's history older than its account's plan allows. `daysFor(plan)` → days. */
      prune(daysFor) {
        const plans = q('SELECT DISTINCT plan FROM accounts').all().map((r) => r.plan);
        for (const plan of plans) {
          q(`DELETE FROM events WHERE at < ? AND app_id IN
             (SELECT apps.id FROM apps JOIN accounts ON accounts.id = apps.account_id WHERE accounts.plan = ?)`)
            .run(now() - daysFor(plan) * DAY_MS, plan);
        }
      },
    },

    usage: {
      get(accountId, m = month(now())) {
        const row = q('SELECT messages, ai_checks FROM usage WHERE account_id = ? AND month = ?').get(accountId, m);
        return { month: m, messages: row?.messages ?? 0, aiChecks: row?.ai_checks ?? 0 };
      },
      add(accountId, { messages = 0, aiChecks = 0 }) {
        q(`INSERT INTO usage (account_id, month, messages, ai_checks) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, month) DO UPDATE SET messages = messages + excluded.messages, ai_checks = ai_checks + excluded.ai_checks`)
          .run(accountId, month(now()), messages, aiChecks);
      },
    },

    discordLinks: {
      create(appId, ttlMs = 60 * 60_000) {
        q('DELETE FROM discord_links WHERE app_id = ? OR expires_at < ?').run(appId, now());
        const code = crypto.randomBytes(6).toString('hex').toUpperCase();
        q('INSERT INTO discord_links (code, app_id, expires_at) VALUES (?, ?, ?)').run(code, appId, now() + ttlMs);
        return { code, expiresAt: now() + ttlMs };
      },
      /** The app a code would link to, without using it up. Null when unknown or expired. */
      peek(code) {
        const row = q('SELECT app_id, expires_at FROM discord_links WHERE code = ?').get(String(code ?? '').trim().toUpperCase());
        return row && row.expires_at >= now() ? api.apps.get(row.app_id) : null;
      },
      /** The app a code links to, using the code up. Null when unknown or expired. */
      consume(code) {
        const row = q('SELECT app_id, expires_at FROM discord_links WHERE code = ?').get(String(code ?? '').trim().toUpperCase());
        if (!row) return null;
        q('DELETE FROM discord_links WHERE code = ?').run(String(code).trim().toUpperCase());
        return row.expires_at < now() ? null : api.apps.get(row.app_id);
      },
    },
  };
  return api;
}
