// Everything an operator might want to tune lives here, read from .env.

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  // --- Web server and accounts ---
  // Where the site is reached from outside, e.g. https://jefbot.example.com (no trailing slash).
  // JEF_PORT / JEF_HOST win over PORT / HOST, for machines where those are taken.
  port: num(process.env.JEF_PORT ?? process.env.PORT, 3000),
  host: process.env.JEF_HOST || process.env.HOST || '0.0.0.0',
  // Which proxies to believe about the client's IP (X-Forwarded-For), in Express's format:
  // the default trusts only proxies on this machine or a private network.
  trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  get publicUrl() {
    return (process.env.PUBLIC_URL || `http://localhost:${this.port}`).replace(/\/+$/, '');
  },
  dbFile: process.env.DB_FILE || 'data/jef-bot.db',
  // Accounts with these emails can see every account (and get the migrated Discord servers).
  adminEmails: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
  // Local testing only: /auth/dev signs in as any email. Never set this on a public server.
  // Also refused whenever PUBLIC_URL is https, which means the server is public.
  devLogin: process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production' && !(process.env.PUBLIC_URL ?? '').startsWith('https:'),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,

  // --- Discord ---
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  // Lets "Add to Discord" link the server to the app automatically (OAuth code exchange).
  // Without it, server managers link with /jef link <code>.
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || null,
  // Optional: register slash commands to one guild instantly instead of globally.
  guildId: process.env.DISCORD_GUILD_ID || null,

  // Where moderation actions are announced for staff. Optional.
  modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || null,

  // AI classification. Without a key the bot falls back to the keyword rules only.
  aiEnabled: process.env.AI_MODERATION !== 'off',
  model: process.env.MOD_MODEL || 'claude-opus-5-5',
  effort: process.env.MOD_EFFORT || 'low',
  // TypeSafe's Jev is used instead of Claude when TYPESAFE_API_KEY is set.
  jevModel: process.env.JEV_MODEL || 'jev-latest',
  // How sure Jev must be (0-1) before a message counts as a violation.
  jevThreshold: num(process.env.JEV_THRESHOLD, 0.9),
  // How sure Jev must be that a message breaks one of a server's own /rule rules.
  jevCustomThreshold: num(process.env.JEV_CUSTOM_THRESHOLD, 0.7),
  // A message at least this likely to be a scam is removed with a lighter mute (0.9+ is a full scam).
  jevScamThreshold: num(process.env.JEV_SCAM_THRESHOLD, 0.6),
  // How sure Jev must be that a member's messages together are griefing or bullying.
  jevPatternThreshold: num(process.env.JEV_PATTERN_THRESHOLD, 0.8),

  // Messages the quick bundled check rates below this go no further (0-1). Lower = safer, more tokens.
  jevGateThreshold: num(process.env.JEV_GATE_THRESHOLD, 0.3),
  // How long (ms) messages wait to be bundled into one quick check.
  jevBatchMs: num(process.env.JEV_BATCH_MS, 2000),
  // Most Jev input tokens to use per day (UTC); then keyword rules only until midnight. 0 = no cap.
  jevDailyTokenBudget: num(process.env.JEV_DAILY_TOKEN_BUDGET, 5_000_000),
  jevUsageFile: process.env.JEV_USAGE_FILE || 'data/jev-usage.json',

  // Griefing and bullying are judged on a member's messages from this many minutes.
  patternWindowMinutes: num(process.env.PATTERN_WINDOW_MINUTES, 30),

  // Channels and roles the bot never moderates, for Discord apps that haven't set their own.
  ignoredChannelIds: list(process.env.IGNORED_CHANNEL_IDS),
  exemptRoleIds: list(process.env.EXEMPT_ROLE_IDS),

  // The single-server bot's data files, imported into the database once (see migrate.js).
  dataFile: process.env.STRIKES_FILE || 'data/strikes.json',
  settingsFile: process.env.SETTINGS_FILE || 'data/guild-settings.json',
  rulesText: process.env.SERVER_RULES || null,
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Punishments, mildest first. Each offense starts at its severity's step and moves one
 * step up for every offense the member still has active; past the last mute is a ban.
 */
export const LADDER = [
  { label: '2 minute mute', timeoutMs: 2 * MIN, message: 'Please keep it respectful. You have been muted for 2 minutes.' },
  { label: '10 minute mute', timeoutMs: 10 * MIN, message: 'That crossed the line. You have been muted for 10 minutes.' },
  { label: '1 hour mute', timeoutMs: HOUR, message: 'You have broken the rules several times recently. You have been muted for 1 hour.' },
  { label: '6 hour mute', timeoutMs: 6 * HOUR, message: 'You keep breaking the rules. You have been muted for 6 hours.' },
  { label: 'FINAL warning + 24 hour mute', timeoutMs: DAY, message: 'This is your FINAL warning. You have been muted for 24 hours. One more offense and you will be banned.' },
];
export const BAN = { label: 'Ban', ban: true, message: 'You have been banned for repeatedly breaking the rules.' };

// start: LADDER step for a first offense. cooldownMs: how long the offense keeps counting,
// so 24 hours without trouble starts a member back at the bottom.
export const SEVERITY = {
  low: { start: 0, cooldownMs: DAY, description: 'subtle rudeness, negativity, flooding chat' },
  medium: { start: 1, cooldownMs: DAY, description: 'clear insult, griefing, bullying, repeated spam' },
  high: { start: 4, cooldownMs: 30 * DAY, description: 'threats, slurs, self-harm incitement, scams' },
};

export const DEFAULT_RULES = `1. Be respectful. No insults, name-calling, or personal attacks.
2. No toxicity: no harassment, hate speech, slurs, threats, or telling people to harm themselves.
3. No griefing: don't organise or brag about wrecking other players' builds, games, or experience; no raiding, spam-pinging, or flooding chat.
4. Keep it positive. Don't trash-talk the server, its members, or its staff, or try to stir up drama.
5. No rudeness: no hostile, demeaning, or deliberately inflammatory messages.
6. No spam or scams: no advertising, repeated messages, fake giveaways, or phishing links.`;
