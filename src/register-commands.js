// One-off: `npm run register` publishes the slash commands to Discord.

import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './discord/commands.js';

if (!config.discordToken || !config.clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env first.');
  process.exit(1);
}

const rest = new REST().setToken(config.discordToken);
const body = commands.map((c) => c.toJSON());
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body });
console.log(`Registered ${body.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally (can take up to an hour to appear)'}.`);
