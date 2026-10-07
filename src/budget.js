// Daily cap on Jev input tokens, so a raid or a busy day can't burn through the account.
// Once the day's budget is used, the bot runs on keyword rules until midnight UTC.
// Saved to disk so a restart doesn't reset the count.

import fs from 'node:fs';
import path from 'node:path';

const today = (ms) => new Date(ms).toISOString().slice(0, 10);

export class DailyBudget {
  constructor({ limit, file = null, now = () => Date.now() }) {
    this.limit = limit;
    this.file = file;
    this.now = now;
    this.day = today(now());
    this.used = 0;
    this.lastSave = 0;
    this.warned = false;
    try {
      const saved = file && JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.day === this.day) this.used = saved.used;
    } catch {
      // No saved usage yet.
    }
  }

  #roll() {
    const day = today(this.now());
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
      this.warned = false;
    }
  }

  /** True while there's budget left today (always true when the limit is 0). */
  ok() {
    this.#roll();
    if (!this.limit || this.used < this.limit) return true;
    if (!this.warned) {
      console.warn(`[budget] daily Jev budget of ${this.limit} tokens used up; keyword rules only until midnight UTC`);
      this.warned = true;
    }
    return false;
  }

  record({ input_tokens: tokens = 0 } = {}) {
    this.#roll();
    this.used += tokens;
    // Write at most every 30 seconds; a few lost tokens on a crash don't matter.
    if (this.file && this.now() - this.lastSave > 30_000) {
      this.lastSave = this.now();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ day: this.day, used: this.used }));
    }
  }
}
