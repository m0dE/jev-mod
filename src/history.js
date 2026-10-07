// What each member has said recently, across channels. Griefing, bullying and mild
// rudeness are judged on this pattern rather than on one message.

import { config } from './config.js';

const MAX_ENTRIES = 15;

export class MessageHistory {
  constructor({ windowMinutes = config.patternWindowMinutes, now = () => Date.now() } = {}) {
    this.windowMs = windowMinutes * 60_000;
    this.now = now;
    this.byUser = new Map();
  }

  #key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /** Recent messages from this member, oldest first, not including `excludeId`. */
  recent(guildId, userId, excludeId) {
    const cutoff = this.now() - this.windowMs;
    const entries = (this.byUser.get(this.#key(guildId, userId)) ?? []).filter((e) => e.at >= cutoff);
    this.byUser.set(this.#key(guildId, userId), entries);
    return entries.filter((e) => e.id !== excludeId);
  }

  /** Record a message. `flagged` is the pattern kind it looked like, if any. An edit replaces the original. */
  add(guildId, userId, { id, channelId = null, channel, to = null, content, flagged = null }) {
    const entries = this.recent(guildId, userId, id);
    entries.push({ id, channelId, channel, to, content: content.slice(0, 300), flagged, at: this.now() });
    this.byUser.set(this.#key(guildId, userId), entries.slice(-MAX_ENTRIES));
  }

  /** Note the pattern kind a recorded message turned out to look like. */
  flag(guildId, userId, id, flagged) {
    const entry = this.byUser.get(this.#key(guildId, userId))?.find((e) => e.id === id);
    if (entry) entry.flagged = flagged;
  }
}
