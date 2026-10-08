// Entry point: one process runs the web server (site, dashboard, API) and, when
// DISCORD_TOKEN is set, the Discord bot. Both moderate through the same moderator.

import { config } from './config.js';
import { openDb } from './db.js';
import { planFor } from './plans.js';
import { createClassifier } from './classifier.js';
import { createModerator } from './moderation.js';
import { createWebhookSender } from './webhooks.js';
import { createServer } from './server/index.js';
import { createAuthRouter } from './server/auth.js';
import { createBilling } from './server/billing.js';
import { createDiscordCallbackRouter } from './server/discord-callback.js';
import { startDiscordBot } from './discord/bot.js';
import { applyManualWarn } from './discord/enforce.js';

const db = openDb(config.dbFile);
const classifier = createClassifier();
const moderator = createModerator({ db, classifier, sendWebhook: createWebhookSender() });

const discord = config.discordToken ? startDiscordBot({ db, moderator, classifier }) : null;
if (!discord) console.log('[discord] DISCORD_TOKEN is not set; running the API and dashboard only');

const billing = createBilling({ db });
const app = createServer({
  db,
  moderator,
  routers: [
    { path: '/auth', router: createAuthRouter({ db }) },
    { path: '/webhooks/stripe', router: billing.webhookRouter },
    { path: '/discord', router: createDiscordCallbackRouter({ db, getClient: () => discord?.client ?? null }) },
  ],
  apiExtensions: [billing.extendApi],
  discordWarn: discord && ((app, w) => applyManualWarn({ client: discord.client, app, ...w })),
});

app.listen(config.port, config.host, () => {
  console.log(`[web] Jef Bot listening on ${config.host}:${config.port} (public URL ${config.publicUrl}). AI: ${classifier.aiName() ?? 'off — keyword rules only'}.`);
});

// Hourly: drop expired sessions, old strikes, and history past each plan's limit.
function cleanUp() {
  db.sessions.prune();
  db.strikes.prune();
  db.events.prune((plan) => planFor({ plan }).historyDays);
}
cleanUp();
setInterval(cleanUp, 60 * 60_000).unref();

// Hourly: how many messages needed Jev, and how much of today's budget is used.
setInterval(() => {
  const s = classifier.takeStats();
  if (!s.messages) return;
  console.log(`[usage] last hour: ${s.messages} messages · skipped ${s.trivial} trivial, ${s.cached} cached, ${s.overQuota} over plan quota, ${s.gatedClean} cleared by quick check · ${s.fullChecks} full checks${s.overBudget ? ` · ${s.overBudget} over budget` : ''} · ${s.tokens} Jev tokens · today ${s.budgetUsedToday}/${s.budgetLimit || '∞'}`);
}, 60 * 60_000).unref();
