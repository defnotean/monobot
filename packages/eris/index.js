// ─── packages/eris/index.js ─────────────────────────────────────────────
// Process entry point: builds the discord.js client, auto-loads events/ +
// commands/, calls initDatabase(), starts the keepalive HTTP server, and
// wires SIGTERM/SIGINT to flush in-memory buffers before exit.
// See docs/start-here.md for the 30-second mental model.
// ─── OpenClaw — Eris Bootstrap ─────────────────────────────────────────

import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http from "http";
import config from "./config.js";
import { initDatabase, flushAll } from "./database.js";
import { log } from "./utils/logger.js";
import { maybeAutoDeploy } from "./utils/autoDeploy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Discord Client ───
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.User, Partials.Reaction],
});

client.commands = new Collection();

// ─── Load Commands ───
async function loadCommands() {
  const commandsDir = join(__dirname, "commands");
  const categories = readdirSync(commandsDir);
  const promises = [];

  for (const category of categories) {
    const categoryPath = join(commandsDir, category);
    const files = readdirSync(categoryPath).filter(f => f.endsWith(".js"));
    for (const file of files) {
      promises.push(
        import(`file://${join(categoryPath, file)}`)
          .then(mod => {
            if (mod.data && mod.execute) {
              client.commands.set(mod.data.name, mod);
            }
          })
          .catch(e => log(`[LOAD] Failed to load command ${file}: ${e.message}`))
      );
    }
  }

  await Promise.allSettled(promises);
  log(`[LOAD] ${client.commands.size} commands loaded`);
}

// ─── Load Events ───
async function loadEvents() {
  const eventsDir = join(__dirname, "events");
  const files = readdirSync(eventsDir).filter(f => f.endsWith(".js"));
  const promises = [];

  for (const file of files) {
    promises.push(
      import(`file://${join(eventsDir, file)}`)
        .then(mod => {
          const handler = mod.default;
          if (!handler) return;
          const eventName = file.replace(".js", "");

          const safeHandler = async (...args) => {
            try { await handler(...args); }
            catch (e) { log(`[EVENT] ${eventName} error: ${e.message}`); }
          };

          if (eventName === "ready") {
            client.once("clientReady", safeHandler);
          } else {
            client.on(eventName, safeHandler);
          }
        })
        .catch(e => log(`[LOAD] Failed to load event ${file}: ${e.message}`))
    );
  }

  await Promise.allSettled(promises);
  log(`[LOAD] ${files.length} event handlers loaded`);
}

// ─── HTTP Server (keepalive + dashboard API) ───
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const { handleApiRequest } = await import("./api/dashboard.js");
    await handleApiRequest(req, res);
    return;
  }
  res.writeHead(200);
  res.end("Eris is awake.");
});

// ─── Startup ───
async function main() {
  log("[SYS] Starting OpenClaw v3...");

  await initDatabase();
  await loadCommands();
  await loadEvents();

  // Auto-register slash commands to Discord if the command set changed since last boot
  try { await maybeAutoDeploy(client.commands); }
  catch (e) { log(`[AUTODEPLOY] Skipped: ${e.message}`); }

  await client.login(config.token);

  // Boot-time firewall seeding — kept off the hot-path so the first message
  // from a user doesn't pay the 10-15s pgvector reseed cost.
  import("./ai/firewall.js").then(async ({ seedPatternsAtBoot }) => {
    const { getSupabase } = await import("./database.js");
    const supabase = getSupabase?.();
    if (supabase) await seedPatternsAtBoot(supabase);
  }).catch(e => log(`[FIREWALL] seed failed: ${e?.message ?? e}`));

  server.listen(config.port, () => {
    log(`[SYS] Server on port ${config.port} (keepalive + dashboard API)`);
  });
}

// ─── Graceful Shutdown ───
async function shutdown(signal) {
  log(`[SYS] ${signal} received — shutting down`);
  await Promise.allSettled([
    flushAll(),
    import("./ai/personality.js").then(m => m.flush()),
    import("./ai/longmemory.js").then(m => m.flush()),
  ]);
  client.destroy();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => log(`[SYS] Unhandled rejection: ${err?.message || err}`));
process.on("uncaughtException", (err) => log(`[SYS] Uncaught exception: ${err?.message || err}`));

main().catch(err => {
  log(`[SYS] Fatal: ${err.message}`);
  process.exit(1);
});
