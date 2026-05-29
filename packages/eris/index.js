// ─── packages/eris/index.js ─────────────────────────────────────────────
// Process entry point: builds the discord.js client, auto-loads events/ +
// commands/, calls initDatabase(), starts the keepalive HTTP server, and
// wires SIGTERM/SIGINT to flush in-memory buffers before exit.
// See docs/start-here.md for the 30-second mental model.
// ─── OpenClaw — Eris Bootstrap ─────────────────────────────────────────

import { Client, Collection, GatewayIntentBits, Partials } from "discord.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http from "http";
import config from "./config.js";
import { initDatabase, flushAll, isPersistenceHealthy } from "./database.js";
import { log } from "./utils/logger.js";
import { maybeAutoDeploy } from "./utils/autoDeploy.js";
import { sendAlert } from "@defnotean/shared/alert";
import { handleAdminAuxRoute } from "./api/adminAuxRoutes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Discord Client ───
// The `commands` Collection is attached below — the standard discord.js pattern
// for a custom command registry. Cast to include it so the `client.commands`
// accesses across this file (and event handlers) type-check.
export const client = /** @type {Client & { commands: Collection<string, any> }} */ (new Client({
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
}));

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

// ─── HTTP Server (keepalive + dashboard API + admin panel) ───
const ADMIN_HTML_PATH = join(__dirname, "api", "admin.html");

const server = http.createServer(async (req, res) => {
  // Admin panel HTML (localhost-only by virtue of the dashboard.js auth bypass)
  if (req.url === "/admin" || req.url === "/admin/" || req.url?.startsWith("/admin?")) {
    if (!existsSync(ADMIN_HTML_PATH)) {
      res.writeHead(404); res.end("admin.html not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.writeHead(200);
    res.end(readFileSync(ADMIN_HTML_PATH, "utf-8"));
    return;
  }

  // Dashboard-admin auxiliary routes: /api/irene/* proxy and /api/logs.
  if (await handleAdminAuxRoute(req, res)) {
    return;
  }

  if (req.url?.startsWith("/api/")) {
    const { handleApiRequest } = await import("./api/dashboard.js");
    await handleApiRequest(req, res);
    return;
  }
  // Discord-aware liveness probe — returns 503 when the gateway is not Ready,
  // so the external healthcheck timer can detect "process alive but Discord
  // WebSocket wedged" and restart us. Other paths (/twin/health, /) keep
  // returning 200 so they're not affected.
  if (req.url === "/healthz") {
    const ready = client.isReady();
    res.setHeader("Content-Type", "application/json");
    res.writeHead(ready ? 200 : 503);
    res.end(JSON.stringify({
      ok: ready,
      discord: ready ? "ready" : "disconnected",
      ws_status: client.ws?.status ?? null,
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(200);
  res.end("Eris is awake.");
});

// ─── Slowloris / slow-body hardening ───
// Render fronts this server with a proxy, but the proxy doesn't shield us from
// a client that opens a connection and dribbles bytes to pin a socket open.
// Cap how long a request may take overall, how long headers may take to
// arrive, and how long an idle keep-alive socket lingers. Tuned well above
// legitimate twin/dashboard latency (sub-second) so real traffic is never cut.
server.requestTimeout = 15000;   // 15s for the full request (headers + body)
server.headersTimeout = 10000;   // 10s to finish sending headers
server.keepAliveTimeout = 5000;  // 5s idle before closing keep-alive sockets
// Per-socket inactivity timeout — closes a connection that goes silent
// mid-stream (the classic slowloris dribble).
server.setTimeout(20000);

// ─── Startup ───
async function main() {
  log("[SYS] Starting OpenClaw v3...");

  await initDatabase();
  startPersistenceMonitor();
  await loadCommands();
  await loadEvents();

  // Start the HTTP server BEFORE attempting Discord login. If Cloudflare/Discord
  // is unreachable at boot (we've seen this routinely), client.login() throws
  // and the whole process used to exit before /admin or /healthz could come up.
  // With the listen() in front, the admin panel + healthz are always reachable
  // — /healthz just reports ws_status=disconnected until the gateway connects.
  //
  // A bind failure (e.g. EADDRINUSE from a stale instance still holding the port
  // after a messy restart) must NOT take the whole bot down. Since uncaughtException
  // now fail-fast exits(1), an unhandled 'error' here would crash-loop the service.
  // Handle it locally: log loudly and keep running — Discord/core still works; only
  // the keepalive/dashboard/admin/twin-punish HTTP surface is unavailable until the
  // port frees and the process restarts.
  server.on("error", (/** @type {NodeJS.ErrnoException} */ e) => {
    if (e.code === "EADDRINUSE") {
      log(`[SYS] ⚠ HTTP port ${config.port} already in use — a stale instance may still be bound. Continuing WITHOUT the HTTP server (keepalive/dashboard/admin/twin-punish unavailable). Free the port and restart to restore them.`);
    } else {
      log(`[SYS] ⚠ HTTP server error: ${e.message}`);
    }
  });
  server.listen(config.port, () => {
    log(`[SYS] Server on port ${config.port} (keepalive + dashboard API)`);
  });

  // Auto-register slash commands to Discord if the command set changed since last boot.
  // This already swallows errors, so a transient outage doesn't kill startup.
  try { await maybeAutoDeploy(client.commands); }
  catch (e) { log(`[AUTODEPLOY] Skipped: ${e.message}`); }

  // Discord login with retry — exponential-ish backoff, never gives up. systemd
  // would restart the process otherwise, but the retry loop is faster and lets
  // the admin panel stay up across the gap.
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await client.login(config.token);
      break;
    } catch (e) {
      attempt++;
      const wait = Math.min(60_000, 5_000 * attempt);
      log(`[SYS] Discord login attempt ${attempt} failed: ${e.message} — retrying in ${wait / 1000}s (HTTP server stays up)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // Boot-time firewall seeding — kept off the hot-path so the first message
  // from a user doesn't pay the 10-15s pgvector reseed cost.
  import("./ai/firewall.js").then(async ({ seedPatternsAtBoot }) => {
    const { getSupabase } = await import("./database.js");
    const supabase = getSupabase?.();
    if (supabase) await seedPatternsAtBoot(supabase);
  }).catch(e => log(`[FIREWALL] seed failed: ${e?.message ?? e}`));
}

// ─── Persistence-health monitor ───
// Polls isPersistenceHealthy() (flips false after N consecutive flush failures)
// and fires an alert on the unhealthy edge + a recovery alert when it returns.
// Edge-triggered so a sustained outage pages once, not every tick; sendAlert's
// own per-kind dedupe is the second line of defense.
const PERSISTENCE_POLL_MS = 30_000;
let _persistenceHealthy = true;
let _persistenceMonitor = null;

function startPersistenceMonitor() {
  if (_persistenceMonitor) return;
  _persistenceMonitor = setInterval(() => {
    let healthy;
    try { healthy = isPersistenceHealthy(); }
    catch { return; } // never let the monitor itself throw
    if (healthy === _persistenceHealthy) return;
    _persistenceHealthy = healthy;
    if (!healthy) {
      log("[SYS] Persistence unhealthy — durable store unreachable");
      sendAlert("persistence-unhealthy", "Durable store unreachable — economy writes refusing", { bot: "ERIS", log });
    } else {
      log("[SYS] Persistence recovered");
      sendAlert("persistence-recovered", "Durable store reachable again", { bot: "ERIS", log });
    }
  }, PERSISTENCE_POLL_MS);
  _persistenceMonitor.unref?.();
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
process.on("unhandledRejection", (/** @type {any} */ err) => log(`[SYS] Unhandled rejection: ${err?.message || err}`));
// Fail-fast on uncaughtException: an uncaught throw means we're in undefined
// state, so continuing to serve risks corrupting data. Log, best-effort
// synchronous flush of in-memory buffers, then exit non-zero so Render
// restarts us cleanly. (unhandledRejection stays log-and-continue above.)
process.on("uncaughtException", (err) => {
  log(`[SYS] Uncaught exception: ${err?.message || err}`);
  // Fire-and-forget alert before we exit. We don't await — the process is in
  // undefined state and Render restarts us; the POST is best-effort.
  try { sendAlert("uncaught-exception", err?.message || String(err), { bot: "ERIS", log }); } catch {}
  try { flushAll(); } catch {}
  process.exit(1);
});

main().catch(err => {
  log(`[SYS] Fatal: ${err.message}`);
  process.exit(1);
});
