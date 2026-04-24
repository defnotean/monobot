import { REST, Routes } from "discord.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import config from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commands = [];

const categoryDirs = readdirSync(join(__dirname, "commands"));
for (const category of categoryDirs) {
  const categoryPath = join(__dirname, "commands", category);
  const files = readdirSync(categoryPath).filter(f => f.endsWith(".js"));
  for (const file of files) {
    const mod = await import(`file://${join(categoryPath, file)}`);
    if (mod.data) commands.push(mod.data.toJSON());
  }
}

const rest = new REST({ version: "10" }).setToken(config.token);
console.log(`Deploying ${commands.length} commands...`);
await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
console.log("Done!");
