# Jef Bot architecture

Jef Bot is hosted chat moderation. One Node process (`npm start`, entry `src/index.js`) runs:

- the **web server**: the public site, docs and dashboard (static files in `docs/`), the `/v1` JSON API, Google sign-in, the Stripe webhook and the Discord "Add to server" callback;
- the **Discord bot**, when `DISCORD_TOKEN` is set. One bot serves every customer's Discord servers.

Jev (TypeSafe's decision model) does the AI judging. "Jef Bot" is the product; "Jev" is the model.

## Concepts

- **Account**: someone who signed in with Google. Has a **plan** (`free`, `starter` $5/mo, `pro` $20/mo; `internal` is unlimited and not sold). Limits are in `src/plans.js`.
- **App**: something being moderated. It's either `kind: "discord"` (linked to one Discord server through `discord_guild_id`) or `kind: "api"` (a game or any other chat, which calls `POST /v1/moderate`). Each app has its own custom rules, strikes, history and settings.
- **API keys**: `jef_acct_…` **account keys** can do anything the owner can, including starting Checkout or opening the billing portal (both return a URL for a person to open). That's how agents set things up headlessly. `jef_app_…` **app keys** work on one app only: moderate, look up and warn or pardon users, and read its rules and history (plus `GET /v1/account`). Only a SHA-256 hash of each key is stored.
- **Strikes**: each offense counts for a while (24 h, or 30 days for severe ones). Active strikes move a user up the punishment ladder (`src/config.js` LADDER: 2 min → 10 min → 1 h → 6 h → 24 h final warning → ban).
- **Events**: moderation history (`action`, `watch`, `manual`, `pardon`). It's kept for the plan's `historyDays`. Clean messages are never stored.
- **Usage**: each account counts messages and AI checks per month (UTC), shared by all its apps. Past `aiChecksPerMonth`, the account's apps fall back to the free keyword, spam and scam rules until the 1st.

## Modules

| File | What |
|---|---|
| `src/index.js` | Wires everything together and starts the web server and Discord bot. Runs hourly cleanup. |
| `src/config.js` | Settings read from `.env`, the punishment ladder and severities. |
| `src/plans.js` | Plans, their limits and Stripe price IDs. `planFor(account)`, `planForPrice(priceId)`, `publicPlans()`, `planLimits(plan)`. |
| `src/db.js` | SQLite (`node:sqlite`). `openDb(file)` returns repositories: `accounts`, `sessions`, `keys`, `apps`, `rules`, `strikes`, `events`, `usage`, `discordLinks`, `meta`, plus `transaction(fn)`. |
| `src/moderation.js` | `createModerator({ db, classifier, sendWebhook })` → `moderate(app, input)`, `warn`, `pardon`, `standing`. Platform-neutral. |
| `src/classifier.js`, `src/jev.js`, `src/gate.js`, `src/rules.js`, `src/spam.js`, `src/budget.js`, `src/history.js` | Decide whether a message breaks the rules (spam → keywords → Jev). `meta.quota.take()` charges the app's monthly AI allowance. |
| `src/ladder.js` | `punishmentFor(severity, prior)`, `describeStep(step)`, `nextPunishments(prior)`. |
| `src/webhooks.js` | Signed outgoing webhooks for paid plans (`Jef-Signature: t=…,v1=…`). Refuses private addresses. |
| `src/migrate.js` | One-time import of the old single-server JSON files into the database. |
| `src/server/index.js` | `createServer({ db, moderator, routers, apiExtensions })`: Express app, security headers, CORS for `/v1`, static site, per-app rate limit. |
| `src/server/api.js` | The `/v1` API (below). Exports `SESSION_COOKIE`, `readCookie`, `isAdmin`, `accountJson`, `appJson`. |
| `src/server/auth.js` | `createAuthRouter({ db })` at `/auth`: Google sign-in, sign-out, dev sign-in. |
| `src/server/billing.js` | `createBilling({ db })` → `{ webhookRouter, extendApi }`: Stripe Checkout, the Customer Portal, the webhook at `/webhooks/stripe` and plan sync. |
| `src/server/discord-callback.js` | `createDiscordCallbackRouter({ db, getClient })` at `/discord`: where Discord sends people after "Add to server"; it links the server to the app. |
| `src/discord/bot.js` | `startDiscordBot({ db, moderator, classifier })` → `{ client }`. Multi-server: a message is moderated only if its server is linked to an app. |
| `src/discord/*.js` | Discord enforcement (delete, DM, timeout, ban, mod log), slash commands (`/strikes /warn /pardon /rule /modlog /jef link`), `invite.js`. |
| `docs/` | Public site, served by the web server at `/`. `docs/app/` is the dashboard (one page, uses `/v1` with the session cookie). `docs/docs/` holds the documentation, plus `docs/openapi.json` and `docs/llms.txt`. |

## HTTP API (`/v1`)

Auth is `Authorization: Bearer <key>`, or the session cookie `jef_session` for the dashboard. Cookie requests that change data must be `Content-Type: application/json` and come from the same site. Errors look like `{ "error": { "code", "message" } }`. Common codes: `unauthorized` 401, `invalid_api_key` 401, `forbidden` 403, `plan_limit` 403, `not_found` 404, `rate_limited` 429, `invalid_request` 400.

| Method & path | Who | What |
|---|---|---|
| `GET /v1/health` | anyone | `{ ok: true }` |
| `GET /v1/plans` | anyone | `{ plans: [...] }` |
| `GET /v1/account` | any | `{ account, limits, usage: { month, messages, aiChecks, apps, accountKeys }, admin, auth }` |
| `GET/POST /v1/keys`, `DELETE /v1/keys/:keyId` | account | Account keys. POST `{ name? }` → `{ key, secret }` (the secret is shown once). |
| `GET/POST /v1/apps` | account | POST `{ name, kind: "api"\|"discord", rules?: [{text, severity}], webhookUrl?, createKey?: true }` → `{ app, appKey?: { key, secret }, discord?: { inviteUrl, linkCode, linkCommand, expiresAt, autoLink } }` |
| `GET/PATCH/DELETE /v1/apps/:appId` | GET: any; others: account | PATCH `{ name?, webhookUrl?, settings?: { modLogChannelId, ignoredChannelIds, exemptRoleIds } }` (settings are for Discord apps only; `null` clears one) |
| `POST /v1/apps/:appId/webhook-secret` | account | Rotate → `{ webhookSecret }` |
| `GET/POST /v1/apps/:appId/keys`, `DELETE …/keys/:keyId` | account | App keys (API apps only). |
| `POST /v1/apps/:appId/discord/link` | account | New invite link and link code (valid 1 h). `DELETE /v1/apps/:appId/discord` unlinks. |
| `GET/POST /v1/apps/:appId/rules`, `DELETE …/rules/:ruleId` | GET: any; others: account | Custom rules `{ text (≤300), severity: low\|medium\|high }` |
| `POST /v1/moderate` | any | `{ appId? (needed with an account key), userId, username?, text, messageId?, room?, replyTo?: string\|{username,text}, context?: [string\|{username,text}] }` → `{ messageId, allow, flagged, category, severity, reason, source, action: { type: none\|delete\|mute\|ban, label, durationMs, message, level? }, strikes, deleteMessages: [{messageId, room}], watch, aiSkipped? }` |
| `GET /v1/apps/:appId/users/:userId` | any | `{ userId, strikes, active: [strike], next: { low, medium, high } }` |
| `POST /v1/apps/:appId/users/:userId/warn` | any | `{ reason, severity?, username?, by? }` → `{ strikes, action }` |
| `POST /v1/apps/:appId/users/:userId/pardon` | any | `{ count?, by? }` → `{ removed, strikes }` |
| `GET /v1/apps/:appId/events?limit&before&userId` | any | `{ events, nextBefore }`, newest first |
| `GET /v1/billing` | session or account key | `{ enabled, plan, subscriptionStatus, currentPeriodEnd, hasCustomer }` |
| `POST /v1/billing/checkout` | session or account key | `{ plan: "starter"\|"pro" }` → `{ url, kind: "checkout"\|"portal" }`. Already-subscribed accounts get the portal, where they change plans. Errors: `billing_unavailable` 503, `billing_error` 502. |
| `POST /v1/billing/portal` | session or account key | → `{ url }`, the Stripe Customer Portal (change or cancel). `no_customer` 400 before the first purchase. |

"any" means a session, an account key, or that app's own app key.

## Other routes

- `GET /auth/google` → Google; `GET /auth/google/callback` signs the user in, creating the account, and redirects to `/app`. `POST /auth/logout`. `GET /auth/dev?email=` only when `DEV_LOGIN=1` and not in production.
- `POST /webhooks/stripe`: Stripe events (raw body, signature checked).
- `GET /discord/callback?code&guild_id&state`: Discord's redirect after "Add to server". `state` is the app's link code.

## Webhooks (paid plans)

`POST <webhookUrl>` with `{ type, appId, createdAt, data }`. Types are `moderation.action`, `moderation.manual` and `moderation.pardon`. The `Jef-Signature: t=<unix>,v1=<hex>` header is the HMAC-SHA256 of `"<t>.<raw body>"` keyed with the app's `webhookSecret`.
