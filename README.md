# jev-mod

A Discord moderation bot. It deletes messages that break the server rules (griefing, bullying, toxic, negative or rude messages, spam and scams) and mutes the sender, for longer each time they reoffend.

## Punishments

Every rule-breaking message is deleted and its sender muted. How long depends on how serious it is and how many offenses they've had recently:

| Severity | Examples | First offense |
|---|---|---|
| Subtle | snarky, dismissive, grumbling about the server, flooding chat, advertising | 2 minute mute |
| Clear | insults, name-calling, griefing, bullying, repeating a message, likely scams | 10 minute mute |
| Severe | threats, slurs, "kys", scams and phishing links | 24 hour mute + final warning |

Each repeat moves one step up the ladder: **2 min → 10 min → 1 h → 6 h → 24 h (final warning) → ban**.

- **Offenses cool down.** Each one counts for 24 hours (severe ones for 30 days). Stay out of trouble for a day and you're back to the start.
- **Griefing and bullying need a pattern.** One message that looks like griefing or bullying is only noted for staff. The bot acts when the person's messages over the last 30 minutes show a real pattern (a plan to wreck someone's base, repeatedly picking on the same person).
- **Spam and scams.** Flooding (6 messages in 10 seconds) and repeating the same message (3 times in a minute, 5 for short ones like "gg") are spam, and the earlier copies are deleted too, in every channel. Scams (fake Nitro/Steam/crypto giveaways, look-alike Discord or Steam links, "I accidentally reported you", asking for logins, selling accounts) get the 24 hour mute, and the scammer's other scam messages are removed. Hacked accounts are the usual culprit, so it's a mute, not a ban. Sharing your own videos and clips is fine; server invites and sales pitches count as advertising.
- **Edited messages are checked too**, so nobody can post something clean and edit it afterward.
- **Exempt:** bots, the server owner, anyone with *Manage Messages*, and any roles or channels you list in `.env`.
- Every action, and every "watching" note, is posted to the mod log channel (`/modlog`).

## How it decides

1. **Keyword rules** (`src/rules.js`) run first. They're free and instant, catch the obvious cases (insults, "kys", threats, "let's grief their base", "this server is trash", mass-pinging), and see through l33t-speak. Put your own banned words and slurs in `config/blocked-words.txt`.
2. **AI** reviews every message the rules don't catch: [Jev](https://docs.typesafe.ai/api) (TypeSafe's decision model) if `TYPESAFE_API_KEY` is set, otherwise Claude if `ANTHROPIC_API_KEY` is set. Jev only flags a message when it's at least `JEV_THRESHOLD` (default 0.9) sure, and leaves friendly banter alone. It reads tone and the last few channel messages, so it can catch rudeness and negativity that keywords miss. It also leaves normal venting, civil disagreement, and playful gaming trash talk alone. It's told to let a message through when it's unsure.

With neither key, the bot runs on keyword rules only.

## Setup

1. **Create the bot.** Go to https://discord.com/developers/applications, click **New Application**, open **Bot**, then **Reset Token** and copy the token.
   - On the same page, turn on the **Message Content Intent** and the **Server Members Intent**.
2. **Invite it.** Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands` and the permissions *View Channels, Send Messages, Manage Messages, Read Message History, Moderate Members, Ban Members, Embed Links*. Open the generated URL.
   - In **Server Settings → Roles**, drag the bot's role **above** the members it moderates. Discord won't let it time out or ban anyone whose role is higher.
3. **Configure and run:**

   ```bash
   cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, TYPESAFE_API_KEY
   npm install
   npm run register          # publishes the slash commands once
   npm start
   ```

## Staff commands

These need the *Moderate Members* permission, and the replies are visible only to you.

- `/strikes user` shows a member's active offenses, when each expires, and what their next offense would get.
- `/warn user reason [severity]` punishes a member manually, on the same ladder (severity defaults to clear/medium).
- `/pardon user [count]` removes the most recent offenses, or all of them.

## Server settings

These need the *Manage Server* permission. Each Discord server has its own settings.

- `/rule add text [severity]` adds a rule of your own, on top of the built-in ones. Write it in plain words, e.g. `No asking for old Braains, or talking about how you miss old Braains`. Severity defaults to low (a 2 minute mute). Up to 15 rules per server.
- `/rule list` and `/rule remove id` show and remove them.
- `/modlog channel` picks the channel where actions, "watching" notes and rule changes are logged.

Server rules need the AI (Jev or Claude): in keyword-only mode only the built-in rules apply.

## Keeping Jev usage down

A full Jev check is about 1,100 input tokens, so the bot avoids sending most messages:

1. **Free checks first.** Spam, scams and obvious insults are caught by the spam and keyword checks without Jev.
2. **Trivial messages are skipped**: emoji only, "gg", "lol", "ok", bot commands like `!rank`.
3. **Recently-clean messages are remembered** for an hour, so repeats aren't sent again.
4. **A quick bundled check.** Messages wait up to 2 seconds (`JEV_BATCH_MS`) and are sent together, up to 20 per request, with one yes/no question each (about 140 tokens per message). Only the ones that might break a rule get the full check.
5. **A daily cap** (`JEV_DAILY_TOKEN_BUDGET`, default 5 million tokens, about $0.21 at current prices). Once it's used up, the bot runs on keyword rules until midnight UTC.
6. **Rate limits are respected.** At most 4 requests run at once; if Jev says to slow down, the bot pauses and uses keyword rules meanwhile.

Every hour the bot logs a `[usage]` line: how many messages it saw, how many were skipped, cached or cleared by the quick check, how many got the full check, and today's token total.

## Configuration

See `.env.example`. You can also:
- Tune how strict the AI is with the `JEV_*_THRESHOLD` settings.
- Change the mute lengths and messages (`LADDER`) and where each severity starts and how long it counts (`SEVERITY`) in `src/config.js`.
- Switch the model with `MOD_MODEL`. The default is `claude-opus-5-5` at low effort.

Offenses are stored in `data/strikes.json`, server rules and log channels in `data/guild-settings.json`, and today's Jev usage in `data/jev-usage.json`. Keep the `data/` folder between restarts.

## Tests

```bash
npm test
```
