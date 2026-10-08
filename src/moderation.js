// Platform-neutral moderation: judge a message for an app, record strikes and history,
// and say what should happen (delete, mute, ban). Discord carries the action out itself
// (see discord/); API apps get it back from POST /v1/moderate and apply it in their game.

import { SEVERITY } from './config.js';
import { planFor, appInPlan, rulesInPlan } from './plans.js';
import { punishmentFor, describeStep, nextPunishments } from './ladder.js';
import { MessageHistory } from './history.js';
import { looksLikeScam } from './rules.js';

// A flood can produce several violations at once: punish once, just delete the rest.
const REPUNISH_MS = 10_000;
// Recent messages per room, used as context when the caller doesn't send any.
const ROOM_CONTEXT = 5;

const NO_ACTION = { type: 'none', label: 'No action', durationMs: null, message: null };
const NOT_IN_PLAN = {
  allow: true, flagged: false, category: null, severity: null, reason: null, source: null, action: NO_ACTION,
  strikes: 0, deleteMessages: [], watch: null, disabled: 'plan_limit',
};

export function createModerator({ db, classifier, history = new MessageHistory(), sendWebhook = async () => false, now = () => Date.now() }) {
  const justPunished = new Map();
  const rooms = new Map();

  function roomContext(appId, room) {
    return rooms.get(`${appId}:${room ?? ''}`) ?? [];
  }
  function remember(appId, room, line) {
    const key = `${appId}:${room ?? ''}`;
    const list = rooms.get(key) ?? [];
    list.push(line);
    rooms.delete(key);
    rooms.set(key, list.slice(-ROOM_CONTEXT));
    if (rooms.size > 20_000) rooms.delete(rooms.keys().next().value);
  }

  // AI checks per account today (UTC). Jev's daily token budget is shared by every account,
  // so no account may use more than a tenth of its monthly allowance in one day.
  const today = new Map();
  function usedToday(accountId) {
    const day = new Date(now()).toISOString().slice(0, 10);
    const entry = today.get(accountId);
    if (entry?.day === day) return entry;
    if (today.size > 50_000) today.clear();
    const fresh = { day, n: 0 };
    today.set(accountId, fresh);
    return fresh;
  }

  /** The account's AI allowance, for the classifier: take() uses one check, or says no. */
  function quotaFor(account) {
    const plan = planFor(account);
    const dailyCap = Math.ceil(plan.aiChecksPerMonth / 10);
    return {
      take() {
        const day = usedToday(account.id);
        if (day.n >= dailyCap || db.usage.get(account.id).aiChecks >= plan.aiChecksPerMonth) return false;
        day.n++;
        db.usage.add(account.id, { aiChecks: 1 });
        return true;
      },
    };
  }

  function notify(app, account, type, data) {
    if (!planFor(account).webhooks) return;
    sendWebhook(app, type, data).catch(() => {});
  }

  /**
   * Judge one message. `input`: { userId, username, text, messageId, room, replyTo, context,
   * mentionCount, roomName }. `room` is a chat room or channel id; `roomName` is how history
   * shows it (defaults to room). `context` (earlier lines, "name: text") is optional; without
   * it the last few messages this app sent for the same room are used.
   *
   * Returns { messageId, allow, flagged, category, severity, reason, source, action,
   * strikes, deleteMessages: [{ messageId, room }], watch, aiSkipped }.
   */
  async function moderate(app, input) {
    const account = db.accounts.get(app.accountId);
    // Past the plan's app limit (after a downgrade): nothing is checked or charged.
    if (!appInPlan(db, app, account)) return { ...NOT_IN_PLAN, messageId: input.messageId == null ? null : String(input.messageId) };
    const userId = String(input.userId);
    const text = String(input.text ?? '');
    const messageId = input.messageId == null ? `m_${now()}_${Math.random().toString(36).slice(2, 8)}` : String(input.messageId);
    const username = input.username ?? userId;
    db.usage.add(account.id, { messages: 1 });

    const recent = input.context ?? roomContext(app.id, input.room);
    remember(app.id, input.room, `${username}: ${text.slice(0, 200)}`);

    // Recorded before the (slow) AI check so a fast flood sees every message.
    const earlier = history.recent(app.id, userId, messageId);
    history.add(app.id, userId, {
      id: messageId, channelId: input.room ?? null, channel: input.roomName ?? input.room ?? null,
      to: input.replyTo ?? null, content: text,
    });

    const verdict = await classifier.classify(text, {
      guildId: app.id,
      customRules: rulesInPlan(db, app, account),
      authorName: username,
      replyTo: input.replyTo ?? null,
      mentionCount: input.mentionCount ?? 0,
      recent: classifier.aiAvailable() ? recent : [],
      history: earlier,
      quota: quotaFor(account),
    });
    history.flag(app.id, userId, messageId, verdict.hint ?? (verdict.violation ? verdict.category : null));

    const result = {
      messageId,
      allow: !verdict.violation,
      flagged: Boolean(verdict.violation),
      category: verdict.violation ? verdict.category : null,
      severity: verdict.violation ? verdict.severity : null,
      reason: verdict.violation ? (verdict.reason || verdict.category) : null,
      source: verdict.source ?? null,
      action: NO_ACTION,
      strikes: db.strikes.count(app.id, userId),
      deleteMessages: [],
      watch: verdict.watch ?? null,
      ...(verdict.aiSkipped ? { aiSkipped: verdict.aiSkipped } : {}),
    };

    if (verdict.watch) {
      db.events.add(app.id, {
        type: 'watch', userId, username, room: input.roomName ?? input.room, messageId, excerpt: text,
        category: verdict.watch, reason: `Possible ${verdict.watch}; needs a pattern before any action`, source: verdict.source,
      });
    }
    if (!verdict.violation) return result;

    // Earlier copies of a spam wave, and the rest of a scam run, go too.
    const extra = [...(verdict.duplicates ?? [])];
    if (verdict.category === 'scam') extra.push(...history.recent(app.id, userId, messageId).filter((h) => looksLikeScam(h.content)));
    const seen = new Set([messageId]);
    result.deleteMessages = extra.filter((e) => !seen.has(e.id) && seen.add(e.id)).map((e) => ({ messageId: e.id, room: e.channelId ?? null }));

    const key = `${app.id}:${userId}`;
    if (now() - (justPunished.get(key) ?? 0) < REPUNISH_MS) {
      result.action = { type: 'delete', label: 'Message removed', durationMs: null, message: null };
      return result;
    }
    justPunished.set(key, now());
    if (justPunished.size > 10_000) justPunished.delete(justPunished.keys().next().value);

    const severity = SEVERITY[verdict.severity] ? verdict.severity : 'medium';
    const step = punishmentFor(severity, db.strikes.count(app.id, userId));
    result.severity = severity;
    result.strikes = db.strikes.add(app.id, userId, {
      category: verdict.category, severity, reason: result.reason, excerpt: text, cooldownMs: SEVERITY[severity].cooldownMs,
    });
    result.action = { ...describeStep(step), level: step.level };

    db.events.add(app.id, {
      type: 'action', userId, username, room: input.roomName ?? input.room, messageId, excerpt: text, category: verdict.category,
      severity, reason: result.reason, source: verdict.source, action: step.label, strikes: result.strikes,
    });
    notify(app, account, 'moderation.action', { userId, username, room: input.room ?? null, text, ...result });
    return result;
  }

  /** A staff member punishes someone by hand: same ladder as automatic offenses. */
  function warn(app, { userId, username = null, reason, severity = 'medium', by }) {
    if (!SEVERITY[severity]) severity = 'medium';
    const step = punishmentFor(severity, db.strikes.count(app.id, userId));
    const strikes = db.strikes.add(app.id, userId, {
      category: 'manual', severity, reason, by: String(by), cooldownMs: SEVERITY[severity].cooldownMs,
    });
    const action = { ...describeStep(step), level: step.level };
    db.events.add(app.id, {
      type: 'manual', userId, username, category: 'manual', severity, reason, action: step.label, strikes, by: String(by),
    });
    notify(app, db.accounts.get(app.accountId), 'moderation.manual', { userId, username, reason, severity, action, strikes, by: String(by) });
    return { strikes, action };
  }

  /** Remove the newest `count` active offenses (all when omitted). */
  function pardon(app, { userId, username = null, count, by }) {
    const removed = db.strikes.pardon(app.id, userId, count ?? undefined);
    const strikes = db.strikes.count(app.id, userId);
    db.events.add(app.id, { type: 'pardon', userId, username, reason: `Removed ${removed} offense(s)`, strikes, by: String(by) });
    notify(app, db.accounts.get(app.accountId), 'moderation.pardon', { userId, username, removed, strikes, by: String(by) });
    return { removed, strikes };
  }

  /** A user's active offenses and what their next one would bring. */
  function standing(app, userId) {
    const active = db.strikes.active(app.id, userId);
    return { userId: String(userId), strikes: active.length, active, next: nextPunishments(active.length) };
  }

  return { moderate, warn, pardon, standing };
}
