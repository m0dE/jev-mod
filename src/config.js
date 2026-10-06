// Everything an admin might want to tune lives here, read from .env.

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  // Optional: register slash commands to one guild instantly instead of globally.
  guildId: process.env.DISCORD_GUILD_ID || null,

  // Where moderation actions are announced for staff. Optional.
  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || null,

  // AI classification. Without a key the bot falls back to the keyword rules only.
  aiEnabled: process.env.AI_MODERATION !== 'off',
  model: process.env.MOD_MODEL || 'claude-opus-5-5',
  effort: process.env.MOD_EFFORT || 'low',

  // Strikes older than this stop counting. 0 = strikes never expire.
  strikeExpiryDays: num(process.env.STRIKE_EXPIRY_DAYS, 30),
  // A "high" severity violation (threats, slurs, telling someone to kill themselves)
  // adds this many strikes at once.
  severeStrikes: num(process.env.SEVERE_STRIKES, 2),

  // Channels and roles the bot never moderates.
  ignoredChannelIds: list(process.env.IGNORED_CHANNEL_IDS),
  exemptRoleIds: list(process.env.EXEMPT_ROLE_IDS),

  dataFile: process.env.STRIKES_FILE || 'data/strikes.json',
  rulesText: process.env.SERVER_RULES || null,
};

/**
 * The escalation ladder. Index = strike count after the offense (1-based).
 * The 4th offense is always a ban; anything beyond 4 is also a ban.
 */
export const LADDER = [
  null,
  { level: 1, action: 'warn', label: 'Warning', timeoutMs: 0,
    message: 'This is a friendly warning. Please keep it respectful.' },
  { level: 2, action: 'timeout', label: 'Formal warning + 10 minute timeout', timeoutMs: 10 * 60_000,
    message: 'This is your second offense. You have been timed out for 10 minutes.' },
  { level: 3, action: 'timeout', label: 'FINAL warning + 24 hour timeout', timeoutMs: 24 * 60 * 60_000,
    message: 'This is your FINAL warning. One more offense and you will be banned.' },
  { level: 4, action: 'ban', label: 'Ban', timeoutMs: 0,
    message: 'You have been banned after four offenses.' },
];

export const MAX_STRIKES = LADDER.length - 1;

export const DEFAULT_RULES = `1. Be respectful. No insults, name-calling, or personal attacks.
2. No toxicity: no harassment, hate speech, slurs, threats, or telling people to harm themselves.
3. No griefing: don't organise or brag about wrecking other players' builds, games, or experience; no raiding, spam-pinging, or flooding chat.
4. Keep it positive. Don't trash-talk the server, its members, or its staff, or try to stir up drama.
5. No rudeness: no hostile, demeaning, or deliberately inflammatory messages.`;
