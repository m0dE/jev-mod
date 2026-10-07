// Offense ledger, persisted to a JSON file: { [guildId]: { [userId]: Strike[] } }.
// Each strike stops counting at its own `until`, so members cool down over time.
// Small servers don't need a database; writes are atomic (temp file + rename).

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
// Records are deleted this long after they stop counting.
const KEEP_EXPIRED_MS = 30 * DAY_MS;

export class StrikeStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  #save() {
    this.#prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  #prune() {
    const cutoff = this.now() - KEEP_EXPIRED_MS;
    for (const [guildId, users] of Object.entries(this.data)) {
      for (const [userId, list] of Object.entries(users)) {
        const kept = list.filter((s) => (s.until ?? s.at + DAY_MS) > cutoff);
        if (kept.length) users[userId] = kept;
        else delete users[userId];
      }
      if (!Object.keys(users).length) delete this.data[guildId];
    }
  }

  /** Delete everything about a server (when the bot is removed from it). */
  forgetGuild(guildId) {
    if (!this.data[guildId]) return;
    delete this.data[guildId];
    this.#save();
  }

  #isActive(strike) {
    return this.now() < (strike.until ?? strike.at + DAY_MS);
  }

  /** Strikes that still count toward the ladder. */
  active(guildId, userId) {
    return (this.data[guildId]?.[userId] ?? []).filter((s) => this.#isActive(s));
  }

  count(guildId, userId) {
    return this.active(guildId, userId).length;
  }

  /** Record an offense that counts for `cooldownMs`; returns the new active count. */
  add(guildId, userId, { category, severity, reason, excerpt, cooldownMs = DAY_MS, by = 'auto' }) {
    const guild = (this.data[guildId] ??= {});
    const list = (guild[userId] ??= []);
    const at = this.now();
    list.push({ at, until: at + cooldownMs, category, severity, reason, excerpt: excerpt?.slice(0, 200), by });
    this.#save();
    return this.count(guildId, userId);
  }

  /** Remove the most recent `n` strikes (or all when n is omitted). Returns how many were removed. */
  pardon(guildId, userId, n) {
    const list = this.data[guildId]?.[userId];
    if (!list?.length) return 0;
    const removed = n == null ? list.length : Math.min(n, list.length);
    list.splice(list.length - removed, removed);
    if (!list.length) delete this.data[guildId][userId];
    this.#save();
    return removed;
  }
}
