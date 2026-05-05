// ─── Media Sub-Executor ─────────────────────────────────────────────────────
// Handles: send_gif, analyze_image, search_images, create_meme, search_meme_templates
// Called from main executor.js via delegation.

import config from "../../config.js";

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
        const res = await fetch(`https://api.klipy.com/api/v1/${config.klipyApiKey}/gifs/search?q=${q}&per_page=20&content_filter=medium&customer_id=${message.author.id}`);
        if (!res.ok) return `gif api error: ${res.status}`;
        const json = await res.json();
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
        const imgRes = await fetch(url);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const base64 = buffer.toString("base64");
        const mimeType = imgRes.headers.get("content-type") || "image/png";

        const { GoogleGenAI } = await import("@google/genai");
        const genai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
        const prompt = input.prompt || input.question || "Describe this image in detail.";
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
        const res = await fetch("https://api.memegen.link/templates");
        const templates = await res.json();
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

        // Download the meme image and upload as attachment (more reliable than embedding URL)
        try {
          const imgRes = await fetch(memeUrl);
          if (imgRes.ok) {
            const ct = imgRes.headers.get("content-type") || "";
            if (!ct.startsWith("image/")) throw new Error("Memegen returned non-image (maybe a bad template)");
            const buffer = Buffer.from(await imgRes.arrayBuffer());
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

        // Method 1: Imgur search (reliable, no auth needed for search)
        try {
          const imgurRes = await fetch(`https://imgur.com/search?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(5000),
          });
          const imgurHtml = await imgurRes.text();
          const imgurMatches = imgurHtml.match(/https:\/\/i\.imgur\.com\/[a-zA-Z0-9]+\.(jpg|png|gif|webp)/g) || [];
          images.push(...imgurMatches.slice(0, 3));
        } catch {}

        // Method 2: Know Your Meme (for meme templates specifically)
        try {
          const kymRes = await fetch(`https://knowyourmeme.com/search?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(5000),
          });
          const kymHtml = await kymRes.text();
          const kymMatches = kymHtml.match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)[^"'\s]*/gi) || [];
          const kymFiltered = kymMatches.filter(u => u.includes("kym-cdn") || u.includes("knowyourmeme")).slice(0, 3);
          images.push(...kymFiltered);
        } catch {}

        // Method 3: Imgflip (meme template database)
        try {
          const flipRes = await fetch(`https://imgflip.com/memesearch?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(5000),
          });
          const flipHtml = await flipRes.text();
          // Extract template page links and visit them for direct image
          const templateLinks = flipHtml.match(/\/memetemplate\/\d+\/[^"'\s]+/g) || [];
          for (const link of templateLinks.slice(0, 2)) {
            try {
              const tplRes = await fetch(`https://imgflip.com${link}`, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
                signal: AbortSignal.timeout(5000),
              });
              const tplHtml = await tplRes.text();
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
          const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
          const ddg = await ddgRes.json();
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
