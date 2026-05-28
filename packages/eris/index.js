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

// ─── HTTP Server (keepalive + dashboard API + admin panel) ───
const ADMIN_HTML_PATH = join(__dirname, "api", "admin.html");
const HOME_DIR = process.env.HOME || `/home/${process.env.USER || "defnotean"}`;
const LOG_DIR = `${HOME_DIR}/.local/monobot-logs`;

// Cross-bot admin proxy — /api/irene/* on Eris's port forwards to Irene's
// :3001/api/*. Lets the admin page (served from Eris) talk to both bots
// without CORS headaches. Localhost-only because both bots bind localhost.
async function proxyToIrene(req, res) {
  const remappedPath = req.url.replace(/^\/api\/irene/, "/api");
  const proxyUrl = `http://127.0.0.1:3001${remappedPath}`;
  try {
    const chunks = [];
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      await new Promise((resolve) => { req.on("data", (c) => chunks.push(c)); req.on("end", resolve); });
    }
    const upstreamReq = http.request(proxyUrl, {
      method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:3001" },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "irene_unreachable", message: e.message }));
    });
    if (chunks.length) upstreamReq.write(Buffer.concat(chunks));
    upstreamReq.end();
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: e.message }));
  }
}

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

  // Cross-bot proxy — admin page calls /api/irene/* for the other bot
  if (req.url?.startsWith("/api/irene/") || req.url === "/api/irene") {
    await proxyToIrene(req, res);
    return;
  }

  // Log tail — /api/logs?bot=eris|irene&lines=N (default 200). Reads from
  // the file logs systemd appends to; admin panel polls this every few sec.
  if (req.url?.startsWith("/api/logs")) {
    try {
      const u = new URL(req.url, `http://localhost:${config.port}`);
      const bot = (u.searchParams.get("bot") || "eris").replace(/[^a-z]/gi, "");
      const lines = Math.min(2000, Math.max(10, parseInt(u.searchParams.get("lines") || "200", 10)));
      const path = `${LOG_DIR}/${bot}.log`;
      if (!existsSync(path)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "log_not_found", path }));
        return;
      }
      const raw = readFileSync(path, "utf-8");
      const allLines = raw.split("\n");
      const tail = allLines.slice(-lines - 1).join("\n");
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ bot, lines: allLines.length, tail }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "log_read_failed", message: e.message }));
    }
    return;
  }

  if (req.url.startsWith("/api/")) {
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

// ─── Startup ───
async function main() {
  log("[SYS] Starting OpenClaw v3...");

  await initDatabase();
  await loadCommands();
  await loadEvents();

  // Start the HTTP server BEFORE attempting Discord login. If Cloudflare/Discord
  // is unreachable at boot (we've seen this routinely), client.login() throws
  // and the whole process used to exit before /admin or /healthz could come up.
  // With the listen() in front, the admin panel + healthz are always reachable
  // — /healthz just reports ws_status=disconnected until the gateway connects.
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
