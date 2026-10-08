# Jef Bot

AI chat moderation for Discord servers, game chat and any app over HTTP. Jef Bot removes rude, toxic, spam and scam messages, spots griefing and bullying across a conversation, and mutes for longer each time someone reoffends, up to a ban. Friendly banter and trash talk are left alone.

Jev, [TypeSafe's](https://docs.typesafe.ai/api) decision model, does the AI judging. "Jef Bot" is the product; "Jev" is the model.

It runs as a hosted, multi-account service: people sign in with Google, create **apps** (a Discord server, or a game that calls the HTTP API), and subscribe through Stripe. This repository is the whole service, and you can host it yourself.

- **Site and docs:** served from `docs/` at `/`. Documentation at `/docs/`, OpenAPI 3.1 at `/openapi.json`, `llms.txt` for AI agents.
- **Architecture:** see [ARCHITECTURE.md](ARCHITECTURE.md).

## Features

- **Discord bot.** One bot serves every customer's servers. It checks new and edited messages, deletes rule-breakers, DMs the member, times them out or bans them, and posts to a mod log. Slash commands: `/strikes`, `/warn`, `/pardon`, `/rule`, `/modlog`, `/jef link`, `/jef status`.
- **HTTP API for games and any chat.** `POST /v1/moderate` returns a verdict (`allow`, `action: none | delete | mute | ban`, duration, a message for the player, earlier messages to delete). The game enforces it.
- **Dashboard** at `/app`: Google sign-in, apps, rules, keys, history, usage, billing.
- **Headless setup.** Account keys (`jef_acct_…`) let AI agents and scripts do everything the dashboard can, including getting a Stripe Checkout link for a person to pay. App keys (`jef_app_…`) only moderate for one app.
- **Custom rules** in plain words per app, judged by the AI.
- **Signed webhooks** for actions, manual warnings and pardons (paid plans).
- **Plans** (`src/plans.js`): Free, Starter ($5/month), Pro ($20/month), plus a hidden unlimited `internal` plan for the operator.

| | Free | Starter | Pro |
|---|---|---|---|
| Apps | 1 | 3 | 15 |
| AI checks / month | 2,000 | 30,000 | 200,000 |
| Custom rules per app | 3 | 15 | 50 |
| History | 7 days | 30 days | 90 days |
| Account keys | 1 | 3 | 10 |
| Webhooks | no | yes | yes |
| `/v1/moderate` per second, per app | 5 | 20 | 50 |

Only messages that reach the AI count as AI checks (confirming a griefing/bullying pattern is one more); spam, scam and keyword checks are free and unlimited. An account can use at most a tenth of its monthly allowance (rounded up) in one UTC day. Past the daily or monthly limit, its apps run on the free checks until it resets, and `/v1/moderate` results carry `aiSkipped: "quota"`.

Limits apply at use time, keeping the oldest items, so a downgrade never deletes anything: apps past the plan's count aren't moderated (`inPlan: false`; `/v1/moderate` returns 403 `plan_limit`, their Discord servers are ignored), only each app's oldest custom rules apply, and account keys past the plan's count get 403 `plan_limit`.

## Punishments

Every rule-breaking message is removed and its sender muted. How long depends on how serious it is and how many offenses they've had recently:

| Severity | Examples | First offense |
|---|---|---|
| Low | snarky, dismissive, grumbling about the community, flooding chat, advertising | 2 minute mute |
| Medium | insults, name-calling, griefing, bullying, repeating a message, likely scams | 10 minute mute |
| High | threats, slurs, "kys", scams and phishing links | 24 hour mute + final warning |

Each repeat moves one step up the ladder: **2 min → 10 min → 1 h → 6 h → 24 h (final warning) → ban**.

- **Offenses cool down.** Each one counts for 24 hours (high ones for 30 days). Stay out of trouble for a day and you're back to the start.
- **Griefing and bullying need a pattern.** One message that looks like griefing or bullying is only noted for staff (a `watch` event, and a "Watching" note in the Discord mod log). Jef Bot acts when the person's messages over the last 30 minutes show a real pattern (a plan to wreck someone's base, repeatedly picking on the same person).
- **Spam and scams.** Flooding (6 messages in 10 seconds) and repeating the same message (3 times in a minute, 5 for short ones like "gg") are spam, and the earlier copies are deleted too, in every channel. Scams (fake Nitro/Steam/crypto giveaways, look-alike Discord or Steam links, "I accidentally reported you", asking for logins, selling accounts) get the 24 hour mute, and the scammer's other scam messages are removed. Hacked accounts are the usual culprit, so it's a mute, not a ban.
- **Edited messages are checked too** on Discord, so nobody can post something clean and edit it afterward.
- **Exempt on Discord:** bots, the server owner, anyone with *Manage Messages*, and the roles and channels each app lists in its settings.

Change the mute lengths and messages (`LADDER`) and where each severity starts and how long it counts (`SEVERITY`) in `src/config.js`.

## How it decides

1. **Spam checks** (`src/spam.js`) look at the sender's recent messages for flooding and repeats.
2. **Keyword rules** (`src/rules.js`) are free and instant, catch the obvious cases (scams, insults, "kys", threats, "let's grief their base", "this server is trash", mass-pinging), and see through l33t-speak. Put your own banned words and slurs in `config/blocked-words.txt` (applies to every app).
3. **AI** reviews the messages those don't catch: Jev if `TYPESAFE_API_KEY` is set, otherwise Claude if `ANTHROPIC_API_KEY` is set. Jev only flags a message when it's at least `JEV_THRESHOLD` (default 0.9) sure. It reads tone, the replied-to message and the last few messages in the room, and leaves friendly banter, venting, civil disagreement and gaming trash talk alone. Each app's custom rules are judged here too (`JEV_CUSTOM_THRESHOLD`, default 0.7).

With neither key, Jef Bot runs on spam and keyword rules only, and custom rules don't apply.

### Keeping Jev usage down

A full Jev check is about 1,100 input tokens, so most messages never get one:

1. **Free checks first.** Spam, scams and obvious insults are caught without Jev.
2. **Trivial messages are skipped**: emoji only, "gg", "lol", "ok", bot commands like `!rank`.
3. **Recently-clean messages are remembered** for an hour, so repeats aren't sent again.
4. **A quick bundled check.** Messages wait up to 2 seconds (`JEV_BATCH_MS`) and are sent together, up to 20 per request, with one yes/no question each (about 140 tokens per message). Only the ones that might break a rule get the full check.
5. **Per-account allowance**: the plan's `aiChecksPerMonth`, and at most a tenth of it per UTC day.
6. **A daily cap for the whole service** (`JEV_DAILY_TOKEN_BUDGET`, default 5 million tokens). Once it's used up, everything runs on keyword rules until midnight UTC.
7. **Rate limits are respected.** At most 4 requests run at once; if Jev says to slow down, Jef Bot pauses and uses keyword rules meanwhile.

Every hour the server logs a `[usage]` line: messages seen, how many were skipped, cached, over quota or cleared by the quick check, how many got the full check, and today's token total.

## Self-hosting

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
git clone https://github.com/m0dE/jev-mod.git jef-bot && cd jef-bot
npm install
cp .env.example .env      # then fill it in, see below
npm run register          # publishes the Discord slash commands (once, and after changing them)
npm start
```

`npm start` runs the web server (site, docs, dashboard, API, Stripe webhook, Discord callback) and, if `DISCORD_TOKEN` is set, the Discord bot, in one process. Put it behind an HTTPS reverse proxy, set `PUBLIC_URL` to the public address, and set `TRUST_PROXY` if the proxy isn't on the same machine or private network. All data is in the SQLite file `DB_FILE` (default `data/jef-bot.db`) plus `data/jev-usage.json`; keep the `data/` folder and back it up.

### Environment

Everything is documented in [`.env.example`](.env.example). The important ones:

| Variable | What |
|---|---|
| `PUBLIC_URL` | Public base URL, no trailing slash, e.g. `https://jefbot.example.com`. Used for every redirect and link. |
| `JEF_PORT`, `JEF_HOST` | Listen address. They win over `PORT` / `HOST`. Default `3000` on `0.0.0.0`. |
| `DB_FILE` | SQLite file. |
| `ADMIN_EMAILS` | Comma-separated admin emails; the first owns migrated Discord servers. |
| `NODE_ENV=production` | On public servers. |
| `TRUST_PROXY` | Express `trust proxy` setting. Default `loopback, linklocal, uniquelocal`. Set it when behind a remote proxy or load balancer (e.g. `1` for one hop) so client IPs are right. |
| `DEV_LOGIN=1` | Local only: `/auth/dev?email=` signs in without Google. Ignored when `NODE_ENV=production` or `PUBLIC_URL` is https; cross-site requests to it are refused. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` | Billing. Without them only Free is available. |
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The Discord bot and automatic linking. |
| `TYPESAFE_API_KEY` (or `ANTHROPIC_API_KEY`) | The AI. |

### Google sign-in

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), configure the OAuth consent screen (scopes `openid`, `email`, `profile`).
2. Create an **OAuth client ID** of type *Web application*.
3. Add the authorized redirect URI **`${PUBLIC_URL}/auth/google/callback`** (e.g. `https://jefbot.example.com/auth/google/callback`).
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Only Google accounts with a verified email can sign in. For local development without Google, set `DEV_LOGIN=1` and open `/auth/dev?email=you@example.com`.

### Discord

1. At https://discord.com/developers/applications click **New Application**.
2. **Bot:** *Reset Token* and copy it to `DISCORD_TOKEN`. Turn on the **Message Content Intent** and the **Server Members Intent**.
3. **General Information:** copy the *Application ID* to `DISCORD_CLIENT_ID`.
4. **OAuth2:** copy the *Client Secret* to `DISCORD_CLIENT_SECRET`, and add the redirect **`${PUBLIC_URL}/discord/callback`**. With this, "Add to server" links the server to the customer's app automatically, as long as the person adding the bot is signed in to the dashboard as the app's owner when Discord redirects back (otherwise the dashboard shows `signed_out` or `not_owner`); without it, or as a fallback, they run `/jef link code:<code>` in their server.
5. Run `npm run register` to publish the slash commands (set `DISCORD_GUILD_ID` to publish to one test server instantly; global commands can take up to an hour).

If the bot is removed from a server while the service is down, that server is unlinked and its strikes and history deleted at the next start. `/warn` refuses when the result would be a ban and the moderator lacks *Ban Members*.

Customers don't need their own Discord application: they add this one bot through the invite link the dashboard gives them. It asks for *View Channels, Send Messages, Manage Messages, Embed Links, Read Message History, Ban Members* and *Moderate Members*, and its role must be above the members it moderates.

### Stripe

1. **Products:** create *Jef Bot Starter* with a recurring price of $5/month and *Jef Bot Pro* with $20/month. Copy the price IDs (`price_…`) to `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`.
2. **API key:** copy the secret key to `STRIPE_SECRET_KEY`.
3. **Webhook:** add an endpoint at **`${PUBLIC_URL}/webhooks/stripe`** with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`. Copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
4. **Customer Portal** (Settings → Billing → Customer portal): allow switching between Starter and Pro (with prorations), cancelling at the end of the period, updating payment methods and viewing invoices. Set the default return URL to `${PUBLIC_URL}/app/account`.
5. **Revenue recovery** (Billing → Revenue recovery): when retries run out, cancel the subscription or mark it unpaid. Either drops the account to Free. While Stripe retries (`past_due`), the account keeps its plan.

For local testing, `stripe listen --forward-to localhost:3000/webhooks/stripe` prints a webhook secret to use. Plan changes happen in the portal: `POST /v1/billing/checkout` only starts new subscriptions, expires the customer's other open Checkout sessions, and returns a portal link to customers who already have one. If a second subscription still starts, the older one is cancelled automatically with proration; the unused time becomes a credit on the customer's Stripe balance, not a card refund. Accounts on the `internal` plan are never changed by Stripe.

### Migrating from the single-server bot

If you ran the old single-server jev-mod, its `data/strikes.json` and `data/guild-settings.json` are imported once, when the Discord bot first connects: every server the bot is in becomes a Discord app owned by the first `ADMIN_EMAILS` address, on the unlimited `internal` plan, with its custom rules, mod log channel and active strikes. Signing in with Google as that email claims the account. The old files are renamed to `*.migrated`. Set `ADMIN_EMAILS` before the first start, or the import waits until you do.

### Tests

```bash
npm test
```

## Documentation

Served by the app (sources in `docs/`):

- `/docs/` overview, `/docs/quickstart-game.html`, `/docs/quickstart-discord.html`
- `/docs/agents.html`: setup by AI agents with an account key
- `/docs/api.html`, `/openapi.json`: the `/v1` API
- `/docs/webhooks.html`, `/docs/rules.html`
- `/llms.txt`, `/llms-full.txt`: for language models
- `/pricing.html`, `/privacy.html`, `/terms.html`

The privacy policy and terms are drafts: have them reviewed and add the operator's legal details before running a public service.

## License

MIT
