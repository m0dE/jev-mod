// Strike ledger, persisted to a JSON file: { [guildId]: { [userId]: Strike[] } }.
// Small servers don't need a database; writes are atomic (temp file + rename).

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export class StrikeStore {
  constructor(file, { expiryDays = 30, now = () => Date.now() } = {}) {
    this.file = file;
    this.expiryDays = expiryDays;
    this.now = now;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  #isActive(strike) {
    return !this.expiryDays || this.now() - strike.at < this.expiryDays * DAY_MS;
  }

  /** Strikes that still count toward the ladder. */
  active(guildId, userId) {
    return (this.data[guildId]?.[userId] ?? []).filter((s) => this.#isActive(s));
  }

  count(guildId, userId) {
    return this.active(guildId, userId).reduce((n, s) => n + (s.weight ?? 1), 0);
  }

  /** Record an offense; returns the new active strike total. */
  add(guildId, userId, { category, reason, excerpt, weight = 1, by = 'auto' }) {
    const guild = (this.data[guildId] ??= {});
    const list = (guild[userId] ??= []);
    list.push({ at: this.now(), category, reason, excerpt: excerpt?.slice(0, 200), weight, by });
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
