// ─── packages/irene/index.js ────────────────────────────────────────────
// Process entry point. Boot order MATTERS: startPresenceAPI →
// initDatabase → loadCommands → loadEvents → registerCommands →
// client.login → setupLavalink. Render's port-detection kills the dyno
// if HTTP isn't open within ~30s; that's why presence API starts first.
// See docs/start-here.md.

// ─── All-in-One Discord Bot ─────────────────────────────────────────────────
// Features: Moderation, Server Setup, AI Chat, Games, Music, Presence API
// ──────────────────────────────────────────────────────────────────────────────

import { Client, GatewayIntentBits, Collection, Partials, Options, REST, Routes } from "discord.js";
import { Shoukaku, Connectors } from "shoukaku";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import config from "./config.js";
import { updatePresence, startPresenceAPI } from "./presence.js";
import { log, redact } from "./utils/logger.js";
import { initDatabase } from "./database.js";
import { initMusic } from "./music/player.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Discord Client ─────────────────────────────────────────────────────────

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.DirectMessage],
  // Keep up to 500 messages per channel in cache (default is 200)
  // This reduces how often delete/edit events arrive as uncached partials during quiet periods
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 500,
  }),
});

client.commands = new Collection();
client._commandDirs = new Map(); // command name → directory (for help auto-categorization)

// ─── Lavalink / Shoukaku (music server) ─────────────────────────────────────
// Initialized AFTER client.login() in main() — Shoukaku needs the gateway connected

function setupLavalink() {
  const nodeUrl = `${config.lavalink.host}:${config.lavalink.port}`;
  log(`[Lavalink] Connecting to ${nodeUrl} (secure: ${config.lavalink.secure})`);

  const lavalinkNodes = [{
    name: "main",
    url: nodeUrl,
    auth: config.lavalink.password,
    secure: config.lavalink.secure,
  }];

  const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), lavalinkNodes, {
    moveOnDisconnect: false,
    resume: true,
    resumeTimeout: 60,
    reconnectTries: 999,      // effectively infinite
    reconnectInterval: 5,     // seconds (not ms)
  });

  shoukaku.on("ready", async (name) => {
    log(`[Lavalink] Node "${name}" connected`);
    // Restore saved music queues after Lavalink is ready
    try {
      const { restoreQueues } = await import("./music/player.js");
      await restoreQueues(client);
    } catch (err) {
      log(`[Music] Queue restore failed: ${err.message}`);
    }
  });
  shoukaku.on("error", (name, error) => log(`[Lavalink] Node "${name}" error: ${error.message}`));
  shoukaku.on("close", (name, code, reason) => log(`[Lavalink] Node "${name}" closed: ${code} ${reason}`));
  shoukaku.on("disconnect", async (name, players, moved) => {
    if (moved) return;
    log(`[Lavalink] Node "${name}" disconnected — ${players.size} players affected. Shoukaku will auto-reconnect (reconnectTries: 999). NOT deleting queues.`);
    // Don't delete queues — Shoukaku's built-in reconnect (reconnectTries: 999)
    // will re-establish the node. Deleting queues here was killing music on
    // every brief Lavalink hiccup. Queues are cleaned up if reconnect ultimately
    // fails via the player "closed" event.
  });

  initMusic(shoukaku);
}

// ─── Load Commands ──────────────────────────────────────────────────────────

async function loadCommands() {
  const commandsPath = join(__dirname, "commands");
  const categories = readdirSync(commandsPath);

  // Collect all file paths first, then import in parallel
  const filePaths = [];
  for (const category of categories) {
    const categoryPath = join(commandsPath, category);
    const commandFiles = readdirSync(categoryPath).filter((f) => f.endsWith(".js"));
    for (const file of commandFiles) filePaths.push({ path: join(categoryPath, file), dir: category });
  }

  const results = await Promise.allSettled(
    filePaths.map((fp) => import(`file://${fp.path.replace(/\\/g, "/")}`))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      log(`[Commands] Failed to load ${filePaths[i].dir}/${filePaths[i].path.split(/[\\/]/).pop()}: ${r.reason?.message ?? r.reason}`);
    } else if (r.value?.data && r.value?.execute) {
      const name = r.value.data.name;
      client.commands.set(name, r.value);
      client._commandDirs.set(name, filePaths[i].dir);
      log(`[Init] Loaded command: /${name}`);
    }
  }

  log(`[Init] Total commands loaded: ${client.commands.size}`);
}

// ─── Load Events ────────────────────────────────────────────────────────────

async function loadEvents() {
  const eventsPath = join(__dirname, "events");
  const eventFiles = readdirSync(eventsPath).filter((f) => f.endsWith(".js"));

  // Import all events in parallel
  const results = await Promise.allSettled(
    eventFiles.map((file) => import(`file://${join(eventsPath, file).replace(/\\/g, "/")}`))
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const event = r.value;
    if (!event.name || !event.execute) continue;

    const safeExecute = (...args) => {
      try {
        const result = event.execute(...args, client);
        if (result instanceof Promise) {
          result.catch((err) => log(`[Event:${event.name}] Unhandled error: ${err?.message ?? err}`));
        }
      } catch (err) {
        log(`[Event:${event.name}] Sync error: ${err?.message ?? err}`);
      }
    };

    if (event.once) {
      client.once(event.name, safeExecute);
    } else {
      client.on(event.name, safeExecute);
    }
    log(`[Init] Loaded event: ${event.name}`);
  }
}

// ─── Client health events ───────────────────────────────────────────────────

client.on("warn", (info) => log(`[WARN] ${info}`));
client.on("error", (err) => log(`[ERROR] ${err.message}`));
client.on("invalidated", () => {
  log("[CRITICAL] Client session invalidated — bot will need to restart");
  process.exit(1);
});
client.on("shardReady", (id) => log(`[SHARD ${id}] Ready`));
client.on("shardDisconnect", (event, id) => log(`[SHARD ${id}] Disconnected (code ${event.code})`));
client.on("shardError", (err, id) => log(`[SHARD ${id}] Error: ${err.message}`));
client.on("shardReconnecting", (id) => log(`[SHARD ${id}] Reconnecting...`));
client.on("shardResume", async (id, replayed) => {
  log(`[SHARD ${id}] Resumed — ${replayed} events replayed — re-warming guild caches`);
  // Re-fetch channels/roles for all guilds after a resume so cache-dependent features
  // (welcome messages, mod logs, create-vc) don't silently fail
  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch().catch((e) => log(`[ShardResume] Cache warm failed for guild: ${e.message}`));
    await guild.roles.fetch().catch((e) => log(`[ShardResume] Cache warm failed for guild: ${e.message}`));
    await guild.members.fetch({ withPresences: true }).catch(() => null);
  }

  // Prune stale tempChannels entries — channels that were deleted while the shard was
  // disconnected won't emit voiceStateUpdate events so in-memory state would leak forever.
  try {
    const { tempChannels, tempTextChannels, tempVcSeq, tempControlPanels, renameTimers, manualRenames, ownerGraceTimers, tempVcCreatedAt, tempVcMembers } = await import("./utils/tempvc.js");
    const { deleteTempVc } = await import("./database.js");
    let pruned = 0;
    for (const [vcId] of tempChannels.entries()) {
      // Check every guild's channel cache for this vcId
      const found = [...client.guilds.cache.values()].some((g) => g.channels.cache.has(vcId));
      if (!found) {
        // Clean up every associated map so nothing leaks
        tempChannels.delete(vcId);
        tempTextChannels.delete(vcId);
        tempVcSeq.delete(vcId);
        tempControlPanels.delete(vcId);
        manualRenames.delete(vcId);
        tempVcCreatedAt.delete(vcId);
        tempVcMembers.delete(vcId);
        const rt = renameTimers.get(vcId);
        if (rt?.timer) clearTimeout(rt.timer);
        renameTimers.delete(vcId);
        const grace = ownerGraceTimers.get(vcId);
        if (grace?.timer) clearTimeout(grace.timer);
        ownerGraceTimers.delete(vcId);
        deleteTempVc(vcId);
        pruned++;
      }
    }
    if (pruned > 0) log(`[ShardResume] Pruned ${pruned} stale temp VC(s)`);
  } catch (err) {
    log(`[ShardResume] Stale VC prune failed: ${err.message}`);
  }
});

// ─── Presence tracking (preserved from original) ───────────────────────────

client.on("presenceUpdate", (oldPresence, newPresence) => {
  try {
    if (newPresence?.userId === config.ownerId) {
      updatePresence(newPresence);
    }
  } catch (err) {
    log(`[Presence] Error: ${err.message}`);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

async function registerCommands() {
  if (!config.token || !config.clientId) {
    log("[Commands] Skipping registration — token or clientId missing");
    return;
  }
  try {
    const body = [...client.commands.values()].map((cmd) => cmd.data.toJSON());
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    log(`[Commands] Registered ${body.length} slash commands globally`);
  } catch (err) {
    log(`[Commands] Registration failed: ${err.message}`);
  }
}

async function main() {
  // Start HTTP server immediately so Render detects an open port within the timeout limit
  startPresenceAPI(client);

  await initDatabase();
  await loadCommands();
  await loadEvents();
  await registerCommands();
  await client.login(config.token);
  setupLavalink();

  // Start feature timers after bot is ready
  client.once("clientReady", async () => {
    // Boot-time firewall seeding — kept off the hot-path so the first message
    // from a user doesn't pay the 10-15s pgvector reseed cost. Fire-and-forget.
    import("./ai/firewall.js").then(async ({ seedPatternsAtBoot }) => {
      const { getSupabase } = await import("./database.js");
      const supabase = getSupabase?.();
      if (supabase) await seedPatternsAtBoot(supabase);
    }).catch(e => log(`[FIREWALL] seed failed: ${e?.message ?? e}`));

    try {
      const { startGiveawayTimers } = await import("./commands/fun/giveaway.js");
      startGiveawayTimers(client);
      log("[Timers] Giveaway timer started");
    } catch (e) { log(`[Timers] Giveaway init failed: ${e.message}`); }

    try {
      const { startPollTimers } = await import("./commands/fun/polladvanced.js");
      startPollTimers(client);
      log("[Timers] Poll timer started");
    } catch (e) { log(`[Timers] Poll init failed: ${e.message}`); }

    try {
      const { startScheduleTimers } = await import("./commands/utility/schedulemsg.js");
      startScheduleTimers(client);
      log("[Timers] Scheduled messages timer started");
    } catch (e) { log(`[Timers] Schedule init failed: ${e.message}`); }

    try {
      const { startYoutubeTimer } = await import("./utils/youtube.js");
      startYoutubeTimer(client);
      log("[Timers] YouTube feed timer started");
    } catch (e) { log(`[Timers] YouTube init failed: ${e.message}`); }

    try {
      const { startGithubTimer } = await import("./utils/github.js");
      startGithubTimer(client);
      log("[Timers] GitHub feed timer started");
    } catch (e) { log(`[Timers] GitHub init failed: ${e.message}`); }

    try {
      const { startVcPolling } = await import("./utils/vcrenamer.js");
      startVcPolling(client);
    } catch (e) { log(`[Timers] VC polling init failed: ${e.message}`); }
  });
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});

// ─── Graceful shutdown ─────────────────────────────────────────────────────
async function shutdown(signal) {
  log(`[SHUTDOWN] Received ${signal} — cleaning up`);

  // PRIORITY 1: Save music queues FIRST and flush to DB immediately.
  // This is the most time-sensitive part — Render can SIGKILL after ~10s.
  // The periodic auto-save (every 60s) provides a safety net, but we want
  // the freshest position possible.
  try {
    const { saveAllQueues } = await import("./music/player.js");
    saveAllQueues();
  } catch (e) { log(`[SHUTDOWN] Queue save failed: ${e.message}`); }

  // PRIORITY 2: Flush DB immediately — don't waste time on cleanup first.
  // Queues, settings, personality, memory all need to hit Supabase before
  // the process is killed. Skip deleteQueue/disconnect — process death
  // handles that automatically.
  try {
    await Promise.race([
      Promise.allSettled([
        import("./database.js").then(m => m.flushNow()),
        import("./ai/personality.js").then(m => m.flush()),
        import("./ai/longmemory.js").then(m => m.flush()),
      ]),
      new Promise(r => setTimeout(r, 8000)), // hard cap — don't block >8s
    ]);
    log("[SHUTDOWN] Database flushed");
  } catch (e) { log(`[SHUTDOWN] Flush error: ${e.message}`); }

  // Cleanup (best-effort, process is about to die anyway)
  try { const { cleanupAllListeners } = await import("./voice/listener.js"); cleanupAllListeners(); } catch {}
  client._httpServer?.close();
  client.destroy();
  log("[SHUTDOWN] Complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Global safety nets — keep the bot alive no matter what ─────────────────
// Unhandled promise rejections (e.g. a misbehaving event handler).
// Stack lines can occasionally embed a failing URL (with query-string auth)
// or an upstream provider's echoed error body — redact() scrubs token-shaped
// substrings BEFORE the logger sees them, and the logger truncates anything
// past MAX_LOG_LINE_BYTES to prevent a runaway stack from filling bot.log.
process.on("unhandledRejection", (reason) => {
  log(`[UNHANDLED REJECTION] ${redact(reason?.stack ?? reason)}`);
});

// Uncaught synchronous exceptions
process.on("uncaughtException", (err) => {
  log(`[UNCAUGHT EXCEPTION] ${redact(err?.stack ?? err)}`);
});
