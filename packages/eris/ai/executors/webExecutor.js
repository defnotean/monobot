// ─── Web Sub-Executor ───────────────────────────────────────────────────────
// Handles: web_search, scrape_url, check_presence
// Called from main executor.js via delegation.

import { GoogleGenAI } from "@google/genai";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { resolveMember } from "../../utils/discord.js";
import * as db from "../../database.js";
import { safeFetch, wrapUntrustedWithFirewall } from "@defnotean/shared/safeFetch";
import { checkInjection } from "../firewall.js";

// Wrap external content fetched by web tools so the LLM treats it as data,
// not as instructions. Runs the firewall on the body and redacts if it fires.
async function wrapWebOutput(content, userId) {
  return wrapUntrustedWithFirewall(content, {
    firewallCheck: (text) => checkInjection(text, db.getSupabase(), userId),
    log,
  });
}

const HANDLED = new Set([
  "web_search", "scrape_url", "check_presence",
]);

function truncate(str, max = 1500) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + "\n...(truncated)" : str;
}

// Reusable Gemini clients for web search grounding — round-robin across keys.
const _groundingClients = (config.geminiKeys ?? []).filter(Boolean).map((k) => new GoogleGenAI({ apiKey: k }));
let _groundingIdx = 0;
function getGroundingClient() {
  if (!_groundingClients.length) return null;
  const c = _groundingClients[_groundingIdx % _groundingClients.length];
  _groundingIdx++;
  return c;
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "web_search": {
      const query = input.query || input.search || input.q;
      if (!query) return "no search query provided";
      const userId = message?.author?.id;

      // ── Tier 1: Gemini Google Search grounding — reliable, uses real Google results ──
      const client = getGroundingClient();
      if (client) {
        try {
          const resp = await Promise.race([
            client.models.generateContent({
              model: config.geminiFastModel,
              contents: [{ role: "user", parts: [{ text: `Search the web for: ${query}\n\nReturn 3-5 concise results with titles, one-line summaries, and source URLs. Plain text, no markdown headers.` }] }],
              config: {
                tools: [{ googleSearch: {} }],
                maxOutputTokens: 1024,
              },
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("grounding timeout")), 25_000)),
          ]);
          const parts = resp?.candidates?.[0]?.content?.parts ?? [];
          const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
          if (text) {
            const sources = resp?.candidates?.[0]?.groundingMetadata?.groundingChunks
              ?.map((c) => c.web?.uri).filter(Boolean).slice(0, 5) ?? [];
            const srcBlock = sources.length ? `\n\nSources:\n${sources.map((u) => `- ${u}`).join("\n")}` : "";
            return wrapWebOutput(`${text}${srcBlock}`, userId);
          }
        } catch (e) {
          log(`[web_search] Gemini grounding failed: ${e.message} — falling back to DDG HTML`);
        }
      }

      // ── Tier 2: DuckDuckGo HTML scraping (last resort, can break when DDG changes markup) ──
      try {
        const res = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          timeoutMs: 10_000,
        });
        const cheerio = await import("cheerio");
        const $ = cheerio.load(res.text);
        const results = [];
        $(".result__body").each((i, el) => {
          if (i >= 5) return false;
          const title = $(el).find(".result__a").text().trim();
          const snippet = $(el).find(".result__snippet").text().trim();
          const href = $(el).find(".result__a").attr("href") || "";
          results.push(`${i + 1}. ${title}\n   ${snippet}\n   ${href}`);
        });
        return results.length ? wrapWebOutput(results.join("\n\n"), userId) : "no results found";
      } catch (e) {
        return `search failed: ${e.message}`;
      }
    }

    case "scrape_url": {
      const url = input.url || input.link;
      if (!url) return "no url provided";
      const userId = message?.author?.id;
      try {
        const res = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          timeoutMs: 10_000,
        });
        const cheerio = await import("cheerio");
        const $ = cheerio.load(res.text);
        $("script, style, nav, footer, header, aside, iframe").remove();
        const text = $("article").text().trim()
          || $("main").text().trim()
          || $("body").text().trim();
        return wrapWebOutput(truncate(text.replace(/\s+/g, " "), 2000), userId);
      } catch (e) {
        return `scrape failed: ${e.message}`;
      }
    }

    case "check_presence": {
      const username = input.username || input.user || input.name;
      if (!username) return "no username provided";
      try {
        const guild = message.guild;
        if (!guild) return "not in a server";
        const member = await resolveMember(guild, username);
        if (!member) return `couldn't find user "${username}"`;
        const presence = member.presence;
        if (!presence) return `${member.displayName} is offline or invisible`;
        const status = presence.status || "offline";
        const activity = presence.activities?.[0];
        let result = `${member.displayName} is ${status}`;
        if (activity) result += ` — ${activity.type === 0 ? "playing" : activity.type === 2 ? "listening to" : activity.type === 3 ? "watching" : "doing"} ${activity.name}`;
        return result;
      } catch (e) {
        return `presence check failed: ${e.message}`;
      }
    }

    default:
      return undefined;
  }
}
