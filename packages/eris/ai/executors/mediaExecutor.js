// ─── Media Sub-Executor ─────────────────────────────────────────────────────
// Handles: send_gif, analyze_image, search_images, create_meme, search_meme_templates
// Called from main executor.js via delegation.
//
// SSRF / size hardening: every URL fetched here can originate from an LLM
// tool call or a user-pasted attachment URL, so all HTTP I/O goes through
// `safeFetch` from @defnotean/shared. That helper enforces the IP / hostname
// blocklist (loopback, RFC1918, link-local incl. 169.254.169.254 cloud
// metadata, ULA, …), re-validates every 3xx hop, and caps the response body
// so a hostile server can't memory-exhaust us. Binary callers
// (`analyze_image`, `create_meme`) ask for raw bytes and tighten the cap to
// 8 MB — well above any legitimate Discord-attachable meme/image.

import config from "../../config.js";
import { safeFetch } from "@defnotean/shared/safeFetch";

// Caps for image fetches. Discord's attachment limit is 25 MB but most memes
// and avatar URLs are < 2 MB; we pick 8 MB as the upper bound an attacker
// can force us to buffer before we abort. Web-search HTML scrapes get a
// smaller 2 MB cap — nothing legitimate needs more than that.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const HTML_MAX_BYTES = 2 * 1024 * 1024;

const HANDLED = new Set([
  "send_gif", "analyze_image", "search_images", "create_meme", "search_meme_templates",
]);

function truncate(str, max = 1500) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + "\n...(truncated)" : str;
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "send_gif": {
      const query = input.query || input.search || "funny";
      if (!config.klipyApiKey) return "gif api not configured";
      try {
        const q = encodeURIComponent(query);
        // Fixed-host API call but still routed through safeFetch — gives us
        // the size cap + redirect re-validation for free in case a future
        // klipy outage 302s us somewhere weird.
        const res = await safeFetch(
          `https://api.klipy.com/api/v1/${config.klipyApiKey}/gifs/search?q=${q}&per_page=20&content_filter=medium&customer_id=${message.author.id}`,
          { maxBytes: HTML_MAX_BYTES, timeoutMs: 8_000 }
        );
        if (res.status < 200 || res.status >= 300) return `gif api error: ${res.status}`;
        let json;
        try { json = JSON.parse(res.text); }
        catch { return "gif api error: invalid response"; }
        const results = json?.data?.data;
        if (!results?.length) return `no gif found for "${query}"`;
        const pick = results[Math.floor(Math.random() * Math.min(results.length, 10))];
        const gifUrl = pick?.file?.hd?.gif?.url ?? pick?.file?.md?.gif?.url ?? pick?.file?.sm?.gif?.url ?? null;
        if (!gifUrl) return `found a result but couldn't extract the gif url`;
        const { EmbedBuilder } = await import("discord.js");
        const embed = new EmbedBuilder()
          .setImage(gifUrl)
          .setColor(config.colors.gif || 0x2b2d31);
        // Resolve @username mentions in caption to proper Discord <@id> pings.
        // Refuse ambiguous names (two members both named "alex") and skip
        // @everyone/@here so we don't accidentally mass-ping. Without these
        // guards we'd ping whichever member the cache iterator yielded first.
        let resolvedCaption = input.caption || "";
        if (resolvedCaption && message.guild) {
          resolvedCaption = resolvedCaption.replace(/@(\w+)/g, (match, name) => {
            const lower = name.toLowerCase();
            if (lower === "everyone" || lower === "here") return name; // strip the @
            const matches = message.guild.members.cache.filter(m =>
              m.user.username.toLowerCase() === lower
              || m.displayName.toLowerCase() === lower
              || m.user.globalName?.toLowerCase() === lower
            );
            if (matches.size === 1) return `<@${matches.first().id}>`;
            return match; // 0 or 2+ matches — keep literal text, don't ping
          });
        }
        const sendOpts = resolvedCaption ? { content: resolvedCaption, embeds: [embed] } : { embeds: [embed] };
        await message.channel.send(sendOpts);
        return `sent gif for ${query}`;
      } catch (e) {
        return `gif search failed: ${e.message}`;
      }
    }

    case "analyze_image": {
      const attachment = message.attachments?.first();
      const url = input.url || input.image_url || attachment?.url;
      if (!url) return "no image provided — attach an image or provide a url";
      try {
        // safeFetch (binary: true) enforces SSRF blocklist + DNS-resolved IP
        // check + 8 MB size cap before we ever materialize the buffer for
        // Gemini. Without it an LLM tool call could point us at
        // 169.254.169.254 or stream a GB image into our heap.
        const imgRes = await safeFetch(url, {
          binary: true,
          maxBytes: IMAGE_MAX_BYTES,
          timeoutMs: 10_000,
        });
        if (imgRes.status < 200 || imgRes.status >= 300) {
          return `image fetch failed: ${imgRes.status}`;
        }
        const buffer = imgRes.bytes;
        const base64 = buffer.toString("base64");
        const mimeType = imgRes.headers.get("content-type") || "image/png";

        const prompt = input.prompt || input.question || "Describe this image in detail.";

        // Local-Ollama vision path. Activated by config.local.ollamaVisionUrl.
        if (config.local?.ollamaVisionUrl) {
          const res = await fetch(`${config.local.ollamaVisionUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: config.local.ollamaVisionModel || "llava:7b",
              messages: [{ role: "user", content: prompt, images: [base64] }],
              stream: false,
            }),
          });
          if (!res.ok) return `image analysis failed: ${res.status}`;
          const data = await res.json();
          return truncate(data?.message?.content || "could not analyze image");
        }

        const { GoogleGenAI } = await import("@google/genai");
        const genai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
        const result = await genai.models.generateContent({
          model: config.geminiFastModel,
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: prompt },
            ],
          }],
        });
        return truncate(result.text || "could not analyze image");
      } catch (e) {
        return `image analysis failed: ${e.message}`;
      }
    }

    case "search_meme_templates": {
      try {
        const query = (input.query || input.search || "").toLowerCase();
        // Fixed-host but still cap the response — memegen returns ~150 KB
        // of JSON, nowhere near our 2 MB ceiling.
        const res = await safeFetch("https://api.memegen.link/templates", {
          maxBytes: HTML_MAX_BYTES,
          timeoutMs: 8_000,
        });
        if (res.status < 200 || res.status >= 300) return `template list error: ${res.status}`;
        let templates;
        try { templates = JSON.parse(res.text); }
        catch { return "template list error: invalid response"; }
        const matches = templates.filter(t =>
          t.name.toLowerCase().includes(query) ||
          t.id.toLowerCase().includes(query) ||
          (t.keywords && t.keywords.some(k => k.toLowerCase().includes(query)))
        ).slice(0, 20);
        if (!matches.length) return `no templates found for "${query}". try a different keyword`;
        return matches.map(t => `${t.id}: ${t.name}${t.keywords?.length ? ` (${t.keywords.slice(0, 3).join(", ")})` : ""}`).join("\n");
      } catch (e) {
        return `template search failed: ${e.message}`;
      }
    }

    case "create_meme": {
      try {
        const topText = input.top_text || input.top || "";
        const bottomText = input.bottom_text || input.bottom || "";
        const caption = input.caption || "";
        const aliases = {
          "distracted-boyfriend": "db",
          "distracted boyfriend": "db",
          "cmm": "change-my-mind"
        };
        let template = (input.template || "drake").toLowerCase();
        template = aliases[template] || template;

        function encMeme(text) {
          if (!text) return "_";
          return encodeURIComponent(text.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_").replace(/\?/g, "~q").replace(/#/g, "~h").replace(/"/g, "''").replace(/%/g, "~p"));
        }

        // Custom background — only from explicit image_url, NEVER auto-avatar
        const bgUrl = input.image_url || input.url || null;

        let memeUrl;
        if (bgUrl) {
          memeUrl = `https://api.memegen.link/images/custom/${encMeme(topText)}/${encMeme(bottomText)}.png?background=${encodeURIComponent(bgUrl)}`;
        } else {
          memeUrl = `https://api.memegen.link/images/${template}/${encMeme(topText)}/${encMeme(bottomText)}.png`;
        }

        // Download the meme image and upload as attachment (more reliable
        // than embedding URL). safeFetch enforces the 8 MB size cap so a
        // memegen redirect or compromised mirror can't stream us GB of
        // garbage.
        try {
          const imgRes = await safeFetch(memeUrl, {
            binary: true,
            maxBytes: IMAGE_MAX_BYTES,
            timeoutMs: 12_000,
          });
          if (imgRes.status >= 200 && imgRes.status < 300) {
            const ct = imgRes.headers.get("content-type") || "";
            if (!ct.startsWith("image/")) throw new Error("Memegen returned non-image (maybe a bad template)");
            const buffer = imgRes.bytes;
            if (buffer.length < 1000) throw new Error("Memegen returned tiny placeholder image");

            const { AttachmentBuilder } = await import("discord.js");
            const attachment = new AttachmentBuilder(buffer, { name: "meme.png" });
            const sendOpts = { files: [attachment] };
            if (caption) sendOpts.content = caption;
            await message.channel.send(sendOpts);
            return "meme sent";
          } else {
            throw new Error(`Memegen API error: ${imgRes.status}`);
          }
        } catch (downloadErr) {
          throw new Error(`Failed to download meme: ${downloadErr.message}`);
        }
      } catch (e) {
        return `meme creation failed: ${e.message}`;
      }
    }

    case "search_images": {
      const query = input.query;
      if (!query) return "no search query";
      try {
        const images = [];
        const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
        const scrapeOpts = {
          headers: { "User-Agent": UA },
          maxBytes: HTML_MAX_BYTES,
          timeoutMs: 5_000,
        };

        // Method 1: Imgur search (reliable, no auth needed for search)
        try {
          const imgurRes = await safeFetch(`https://imgur.com/search?q=${encodeURIComponent(query)}`, scrapeOpts);
          const imgurMatches = imgurRes.text.match(/https:\/\/i\.imgur\.com\/[a-zA-Z0-9]+\.(jpg|png|gif|webp)/g) || [];
          images.push(...imgurMatches.slice(0, 3));
        } catch {}

        // Method 2: Know Your Meme (for meme templates specifically)
        try {
          const kymRes = await safeFetch(`https://knowyourmeme.com/search?q=${encodeURIComponent(query)}`, scrapeOpts);
          const kymMatches = kymRes.text.match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)[^"'\s]*/gi) || [];
          const kymFiltered = kymMatches.filter(u => u.includes("kym-cdn") || u.includes("knowyourmeme")).slice(0, 3);
          images.push(...kymFiltered);
        } catch {}

        // Method 3: Imgflip (meme template database)
        try {
          const flipRes = await safeFetch(`https://imgflip.com/memesearch?q=${encodeURIComponent(query)}`, scrapeOpts);
          const flipHtml = flipRes.text;
          // Extract template page links and visit them for direct image
          const templateLinks = flipHtml.match(/\/memetemplate\/\d+\/[^"'\s]+/g) || [];
          for (const link of templateLinks.slice(0, 2)) {
            try {
              const tplRes = await safeFetch(`https://imgflip.com${link}`, scrapeOpts);
              const tplHtml = tplRes.text;
              // Match both https:// and protocol-relative //i.imgflip.com URLs
              const directUrls = tplHtml.match(/(?:https?:)?\/\/i\.imgflip\.com\/[^"'\s]+\.(?:jpg|png|webp)/gi) || [];
              for (const u of directUrls.slice(0, 2)) {
                images.push(u.startsWith("//") ? `https:${u}` : u);
              }
              if (images.length >= 3) break;
            } catch {}
          }
          // Also grab any direct i.imgflip.com URLs from search results page
          const flipDirect = flipHtml.match(/(?:https?:)?\/\/i\.imgflip\.com\/[^"'\s]+\.(?:jpg|png)/gi) || [];
          for (const u of flipDirect.slice(0, 3)) {
            images.push(u.startsWith("//") ? `https:${u}` : u);
          }
        } catch {}

        // Method 4: DuckDuckGo instant answer
        try {
          const ddgRes = await safeFetch(
            `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
            { maxBytes: HTML_MAX_BYTES, timeoutMs: 5_000 }
          );
          const ddg = JSON.parse(ddgRes.text);
          if (ddg.Image) images.push(ddg.Image.startsWith("http") ? ddg.Image : `https://duckduckgo.com${ddg.Image}`);
        } catch {}

        // Deduplicate and clean
        const unique = [...new Set(images)].filter(u => u.length > 10 && u.length < 500).slice(0, 8);

        if (!unique.length) return `no images found for "${query}" — try different search terms`;
        return `FOUND IMAGES — you MUST now call create_meme with image_url set to the first URL:\nimage_url: ${unique[0]}\n\nall results:\n${unique.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n\nIMPORTANT: call create_meme with image_url="${unique[0]}" — do NOT use a template name, use this URL`;
      } catch (e) {
        return `image search failed: ${e.message}`;
      }
    }

    default:
      return undefined;
  }
}
