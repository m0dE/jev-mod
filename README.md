# jev-mod

A Discord moderation bot. It deletes messages that break the server rules (griefing, toxic, negative, or rude messages) and escalates on each offense. The 4th offense is a ban.

## The strike ladder

| Strike | What happens |
|---|---|
| 1 | Message deleted, warning sent by DM and as a short notice in the channel |
| 2 | Message deleted, formal warning, **10 minute timeout** |
| 3 | Message deleted, **final warning**, **24 hour timeout** |
| 4 | Message deleted, **ban** (also deletes their last hour of messages) |

- **Severe offenses count double.** Threats, slurs, and "kys" add 2 strikes (`SEVERE_STRIKES`).
- **Strikes expire** after 30 days (`STRIKE_EXPIRY_DAYS`, set it to 0 to keep them forever).
- **Edited messages are checked too**, so nobody can post something clean and edit it afterward.
- **Exempt:** bots, the server owner, anyone with *Manage Messages*, and any roles or channels you list in `.env`.
- Every action is posted to `MOD_LOG_CHANNEL_ID` if you set one.

## How it decides

1. **Keyword rules** (`src/rules.js`) run first. They're free and instant, catch the obvious cases (insults, "kys", threats, "let's grief their base", "this server is trash", mass-pinging), and see through l33t-speak. Put your own banned words and slurs in `config/blocked-words.txt`.
2. **Claude** reviews every message the rules don't catch. It reads tone and the last few channel messages, so it can catch rudeness and negativity that keywords miss. It also leaves normal venting, civil disagreement, and playful gaming trash talk alone. It's told to let a message through when it's unsure.

Without `ANTHROPIC_API_KEY`, the bot runs on keyword rules only.

## Setup

1. **Create the bot.** Go to https://discord.com/developers/applications, click **New Application**, open **Bot**, then **Reset Token** and copy the token.
   - On the same page, turn on the **Message Content Intent** and the **Server Members Intent**.
2. **Invite it.** Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands` and the permissions *View Channels, Send Messages, Manage Messages, Read Message History, Moderate Members, Ban Members, Embed Links*. Open the generated URL.
   - In **Server Settings → Roles**, drag the bot's role **above** the members it moderates. Discord won't let it time out or ban anyone whose role is higher.
3. **Configure and run:**

   ```bash
   cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, ANTHROPIC_API_KEY
   npm install
   npm run register          # publishes the slash commands once
   npm start
   ```

## Staff commands

These need the *Moderate Members* permission, and the replies are visible only to you.

- `/strikes user` shows a member's active strikes and why they got each one.
- `/warn user reason` gives a manual strike, which follows the same ladder.
- `/pardon user [count]` removes the most recent strikes, or all of them.

## Configuration

See `.env.example`. You can also:
- Replace the built-in rules Claude judges against with `SERVER_RULES`.
- Change the ladder (timeout lengths, messages) in `LADDER` in `src/config.js`.
- Switch the model with `MOD_MODEL`. The default is `claude-opus-5-5` at low effort.

Strikes are stored in `data/strikes.json`.

## Tests

```bash
npm test
```
