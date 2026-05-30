import http from "http";
import { existsSync, readFileSync } from "fs";
import config from "../config.js";
import { requireDashboardAuth, enforceDashboardRateLimit } from "./dashboard.js";

const HOME_DIR = process.env.HOME || `/home/${process.env.USER || "defnotean"}`;
const LOG_DIR = `${HOME_DIR}/.local/monobot-logs`;
const MAX_PROXY_BODY_BYTES = 1_048_576;

// Cross-bot admin proxy: /api/irene/* on Eris's port forwards to Irene's
// :3001/api/*. The caller must pass Eris dashboard auth before this proxy
// runs; otherwise a remote request would become localhost from Irene's view.
export async function proxyToIrene(req, res) {
  const remappedPath = req.url.replace(/^\/api\/irene/, "/api");
  const proxyUrl = `http://127.0.0.1:3001${remappedPath}`;
  try {
    const chunks = [];
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      let total = 0;
      const tooLarge = await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          total += c.length;
          if (total > MAX_PROXY_BODY_BYTES) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload too large" }));
            req.destroy();
            resolve(true);
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => resolve(false));
        req.on("error", reject);
      });
      if (tooLarge) return;
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

export function handleLogs(req, res) {
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
}

export async function handleAdminAuxRoute(req, res) {
  if (req.url?.startsWith("/api/irene/") || req.url === "/api/irene") {
    // These aux routes run BEFORE handleApiRequest, where the per-IP limiter
    // normally fires — so without this they'd be auth-gated but NOT rate-
    // limited. Enforce the SAME 30 req/min/IP bucket here (mirrors the order
    // in handleApiRequest: rate-limit first, then auth).
    if (enforceDashboardRateLimit(req, res)) return true;
    if (!requireDashboardAuth(req, res)) return true;
    await proxyToIrene(req, res);
    return true;
  }

  if (req.url?.startsWith("/api/logs")) {
    if (enforceDashboardRateLimit(req, res)) return true;
    if (!requireDashboardAuth(req, res)) return true;
    handleLogs(req, res);
    return true;
  }

  return false;
}
