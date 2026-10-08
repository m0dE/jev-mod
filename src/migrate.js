// One-time move from the single-server bot's JSON files (data/strikes.json,
// data/guild-settings.json) into the database. Every Discord server the bot is in becomes a
// Discord app owned by the first ADMIN_EMAILS account, on the unlimited internal plan;
// signing in with Google as that email claims it.

import fs from 'node:fs';
import { config } from './config.js';

// A missing file means there's nothing to move. Anything else (corrupt JSON, no permission)
// throws, so the move isn't marked done and is tried again on the next start.
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Can't read ${file}: ${err.message}`);
  }
};

/** `guilds`: [{ id, name }] the bot is in now. Safe to call on every start; it only runs once. */
export function migrateLegacy(db, { guilds = [], strikesFile = config.dataFile, settingsFile = config.settingsFile, log = console } = {}) {
  if (db.meta.get('legacy_migrated')) return null;
  const strikes = readJson(strikesFile) ?? {};
  const settings = readJson(settingsFile) ?? {};
  const names = new Map(guilds.map((g) => [g.id, g.name]));
  const guildIds = [...new Set([...names.keys(), ...Object.keys(strikes), ...Object.keys(settings)])];
  if (!guildIds.length) {
    db.meta.set('legacy_migrated', new Date().toISOString());
    return { apps: 0 };
  }
  const email = config.adminEmails[0];
  if (!email) {
    log.warn('[migrate] ADMIN_EMAILS is not set, so existing Discord servers have no owner yet. Set it and restart.');
    return null;
  }

  const run = db.transaction(() => {
    let owner = db.accounts.byEmail(email) ?? db.accounts.create({ email, plan: 'internal' });
    if (owner.plan === 'free') owner = db.accounts.setBilling(owner.id, { plan: 'internal' });
    let count = 0;
    for (const guildId of guildIds) {
      if (db.apps.byGuild(guildId)) continue;
      const s = settings[guildId] ?? {};
      const app = db.apps.create({
        accountId: owner.id, name: names.get(guildId) ?? `Discord server ${guildId}`, kind: 'discord',
        settings: s.modLogChannelId ? { modLogChannelId: s.modLogChannelId } : {},
      });
      db.apps.setGuild(app.id, guildId);
      for (const r of s.rules ?? []) db.rules.add(app.id, r.text, r.severity);
      for (const [userId, list] of Object.entries(strikes[guildId] ?? {})) {
        for (const st of list) {
          const until = st.until ?? st.at + 86_400_000;
          db.strikes.add(app.id, userId, { ...st, cooldownMs: until - st.at, at: st.at });
        }
      }
      count++;
    }
    db.meta.set('legacy_migrated', new Date().toISOString());
    return count;
  });
  const apps = run();
  for (const file of [strikesFile, settingsFile]) {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
  }
  log.log(`[migrate] moved ${apps} Discord server(s) into the database, owned by ${email}`);
  return { apps };
}
