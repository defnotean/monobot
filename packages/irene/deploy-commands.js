// ─── Register Slash Commands with Discord API ──────────────────────────────
// Run: node deploy-commands.js
// This registers all slash commands globally (may take up to 1 hour to propagate)
// ──────────────────────────────────────────────────────────────────────────────

import { REST, Routes } from "discord.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import config from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const commands = [];
const commandsPath = join(__dirname, "commands");
const categories = readdirSync(commandsPath);

for (const category of categories) {
  const categoryPath = join(commandsPath, category);
  const commandFiles = readdirSync(categoryPath).filter((f) => f.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = join(categoryPath, file);
    const command = await import(`file://${filePath.replace(/\\/g, "/")}`);
    if (command.data) {
      commands.push(command.data.toJSON());
      console.log(`Loaded: /${command.data.name}`);
    }
  }
}

const rest = new REST({ version: "10" }).setToken(config.token);

try {
  console.log(`\nRegistering ${commands.length} commands globally...`);

  const data = /** @type {any[]} */ (await rest.put(Routes.applicationCommands(config.clientId), { body: commands }));

  console.log(`Successfully registered ${data.length} commands!`);
  console.log("\nNote: Global commands may take up to 1 hour to appear in all servers.");
  console.log("For instant testing, use guild-specific commands instead.");
} catch (error) {
  console.error("Failed to register commands:", error);
}
