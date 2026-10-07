// Per-server settings that staff change from Discord: custom rules and the mod log
// channel. Persisted to a JSON file: { [guildId]: { rules: Rule[], nextRuleId, modLogChannelId } }.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_CUSTOM_RULES = 15;

export class GuildSettings {
  constructor(file) {
    this.file = file;
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

  #guild(guildId) {
    return (this.data[guildId] ??= { rules: [], nextRuleId: 1, modLogChannelId: null });
  }

  /** Custom rules for a server: [{ id, text, severity }]. */
  rules(guildId) {
    return this.data[guildId]?.rules ?? [];
  }

  /** Returns the new rule, or null when the server already has the maximum. */
  addRule(guildId, text, severity = 'low') {
    const guild = this.#guild(guildId);
    if (guild.rules.length >= MAX_CUSTOM_RULES) return null;
    const rule = { id: guild.nextRuleId++, text: text.trim().slice(0, 300), severity };
    guild.rules.push(rule);
    this.#save();
    return rule;
  }

  removeRule(guildId, id) {
    const guild = this.data[guildId];
    const i = guild?.rules.findIndex((r) => r.id === id) ?? -1;
    if (i < 0) return null;
    const [removed] = guild.rules.splice(i, 1);
    this.#save();
    return removed;
  }

  forgetGuild(guildId) {
    if (!this.data[guildId]) return;
    delete this.data[guildId];
    this.#save();
  }

  modLogChannelId(guildId) {
    return this.data[guildId]?.modLogChannelId ?? null;
  }

  setModLogChannel(guildId, channelId) {
    this.#guild(guildId).modLogChannelId = channelId;
    this.#save();
  }
}
