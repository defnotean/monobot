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
import { isExplicitGifRequest, recordNaturalGif, shouldAllowNaturalGif } from "@defnotean/shared/gifCadence";
import { describeImageAttachment, describeImageAttachments, formatImageDescriptions } from "@defnotean/shared/localVision";

// Caps for image fetches. Discord's attachment limit is 25 MB but most memes
// and avatar URLs are < 2 MB; we pick 8 MB as the upper bound an attacker
// can force us to buffer before we abort. Web-search HTML scrapes get a
// smaller 2 MB cap — nothing legitimate needs more than that.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const HTML_MAX_BYTES = 2 * 1024 * 1024;

const HANDLED = new Set([
  "send_gif", "analyze_image", "search_images", "show_image", "create_meme", "search_meme_templates",
  "send_file", "generate_image", "edit_image",
]);

function truncate(str, max = 1500) {
  if (!str) return "(empty)";
  return str.length > max ? str.slice(0, max) + "\n...(truncated)" : str;
}

function resolveCaptionMentions(caption, guild) {
  let content = (caption || "").trim();
  const allowedUsers = new Set();
  if (content && guild) {
    content = content.replace(/@(\w+)/g, (match, name) => {
      const lower = name.toLowerCase();
      if (lower === "everyone" || lower === "here") return name;
      const matches = guild.members.cache.filter(m =>
        m.user.username.toLowerCase() === lower
        || m.displayName.toLowerCase() === lower
        || m.user.globalName?.toLowerCase() === lower
      );
      if (matches.size === 1) {
        const member = matches.first();
        allowedUsers.add(member.id);
        return `<@${member.id}>`;
      }
      return match;
    });
  }
  return {
    content,
    allowedMentions: {
      parse: [],
      ...(allowedUsers.size ? { users: [...allowedUsers] } : {}),
    },
  };
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "send_gif": {
      const query = input.query || input.search || "funny";
      const gifScope = `${message.guild?.id || "dm"}:${message.channel?.id || "dm"}`;
      const explicitGif = isExplicitGifRequest(`${message.content || ""} ${input.caption || ""}`);
      if (!explicitGif) {
        const cadence = shouldAllowNaturalGif(gifScope);
        if (!cadence.allowed) return "natural GIF skipped: cooldown active. Reply with text instead and do not mention the cooldown.";
      }
      if (!config.klipyApiKey) return "couldn't send a gif right now. continue naturally without mentioning internal setup.";
      try {
        const q = encodeURIComponent(query);
        // Fixed-host API call but still routed through safeFetch — gives us
        // the size cap + redirect re-validation for free in case a future
        // klipy outage 302s us somewhere weird.
        const res = await safeFetch(
          `https://api.klipy.com/api/v1/${config.klipyApiKey}/gifs/search?q=${q}&per_page=20&content_filter=medium&customer_id=${message.author.id}`,
          { maxBytes: HTML_MAX_BYTES, timeoutMs: 8_000 }
        );
        if (res.status < 200 || res.status >= 300) return "couldn't find a usable gif right now. continue naturally without mentioning the gif service.";
        let json;
        try { json = JSON.parse(res.text || ""); }
        catch { return "couldn't find a usable gif right now. continue naturally without mentioning the gif service."; }
        const results = json?.data?.data;
        if (!results?.length) return `no gif found for "${query}". continue naturally without mentioning the gif service.`;
        const pick = results[Math.floor(Math.random() * Math.min(results.length, 10))];
        const gifUrl = pick?.file?.hd?.gif?.url ?? pick?.file?.md?.gif?.url ?? pick?.file?.sm?.gif?.url ?? null;
        if (!gifUrl) return "couldn't find a usable gif right now. continue naturally without mentioning the gif service.";
        const { EmbedBuilder } = await import("discord.js");
        const embed = new EmbedBuilder()
          .setImage(gifUrl)
          .setColor(config.colors.gif || 0x2b2d31);
        const { content: resolvedCaption, allowedMentions } = resolveCaptionMentions(input.caption, message.guild);
        const sendOpts = resolvedCaption
          ? {
              content: resolvedCaption,
              embeds: [embed],
              allowedMentions,
            }
          : { embeds: [embed], allowedMentions };
        try {
          await message.channel.send(sendOpts);
        } catch {
          const fallback = resolvedCaption ? `${resolvedCaption}\n${gifUrl}` : gifUrl;
          const sent = await message.channel.send({ content: fallback, allowedMentions }).then(() => true).catch(() => false);
          if (!sent) return "couldn't send a gif right now. continue naturally without mentioning the send failure.";
        }
        if (!explicitGif) recordNaturalGif(gifScope);
        return `sent gif for ${query}`;
      } catch (e) {
        return "couldn't find a usable gif right now. continue naturally without mentioning the gif service.";
      }
    }

    // Find a REAL photo of a subject and POST it inline with the bot's caption.
    // Free, no API key: Wikipedia (best for "what does X look like") → Openverse
    // (CC image search) fallback. Mirrors send_gif's embed-and-send pattern.
    case "show_image": {
      const query = input.query || input.search || input.q;
      if (!query) return "no image query provided";
      const q = encodeURIComponent(query);
      const fetchOpts = { headers: { "User-Agent": "Mozilla/5.0 (compatible; eris-bot/3 image lookup)" }, maxBytes: HTML_MAX_BYTES, timeoutMs: 6_000 };
      let imageUrl = null;
      let source = null;

      // Source 1: Wikipedia — search for the best page, then grab its lead image.
      try {
        const sr = await safeFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=1&format=json&origin=*`, fetchOpts);
        const title = JSON.parse(sr.text || "")?.query?.search?.[0]?.title;
        if (title) {
          const pr = await safeFetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&piprop=original%7Cthumbnail&pithumbsize=800&format=json&origin=*`, fetchOpts);
          const pages = JSON.parse(pr.text || "")?.query?.pages || {};
          const page = Object.values(pages)[0];
          const candidate = page?.original?.source || page?.thumbnail?.source || null;
          // Discord embeds can't render SVG — skip those so we fall through.
          if (candidate && !/\.svg(\?|$)/i.test(candidate)) { imageUrl = candidate; source = "wikipedia"; }
        }
      } catch {}

      // Source 2: Openverse — free CC image search, no key, broader coverage.
      if (!imageUrl) {
        try {
          const or = await safeFetch(`https://api.openverse.org/v1/images/?q=${q}&page_size=5&mature=false`, fetchOpts);
          const item = (JSON.parse(or.text || "")?.results || []).find((r) => r.url && !/\.svg(\?|$)/i.test(r.url));
          if (item) { imageUrl = item.url || item.thumbnail; source = "openverse"; }
        } catch {}
      }

      if (!imageUrl) return `couldn't find a good photo of "${query}" — tell the user in your own words (maybe describe it instead)`;

      try {
        const { EmbedBuilder } = await import("discord.js");
        const embed = new EmbedBuilder().setImage(imageUrl).setColor(config.colors?.gif || 0x2b2d31);
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, message.guild);
        await message.channel.send({
          ...(caption ? { content: caption } : {}),
          embeds: [embed],
          // A caption is the bot's own text — never let it mass-ping the server.
          allowedMentions,
        });
        return `posted a real photo of "${query}" (via ${source}) with your caption — the user can see the image now, so don't re-describe what's in it`;
      } catch (e) {
        return `found an image but couldn't post it: ${e.message}`;
      }
    }

    // Post long content (code/scripts/text) as a downloadable FILE so it's never
    // truncated by the reply char-budget. Short caption in chat + the file attached.
    case "send_file": {
      const content = input.content;
      if (!content) return "no file content provided";
      const filename = (input.filename || "file.txt").replace(/[^\w.\- ]/g, "_").slice(0, 80) || "file.txt";
      try {
        const buffer = Buffer.from(String(content), "utf-8");
        if (buffer.length > 7_000_000) return "that content is too large to attach (>7MB) — trim it down";
        const { AttachmentBuilder } = await import("discord.js");
        const attachment = new AttachmentBuilder(buffer, { name: filename });
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, message.guild);
        await message.channel.send({
          ...(caption ? { content: caption } : {}),
          files: [attachment],
          allowedMentions,
        });
        return `posted "${filename}" as a file attachment with your caption — done; do NOT also paste the contents inline`;
      } catch (e) {
        return `couldn't send the file: ${e.message}`;
      }
    }

    // Generate brand-new AI art from a text prompt (Imagen) and post it.
    case "generate_image": {
      const prompt = input.prompt;
      if (!prompt || prompt.length < 3) return "give me a longer description of the image to make";
      if (!config.geminiKeys?.length) return "image generation isn't set up (no Gemini key)";
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const genai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
        const MODELS = ["imagen-4.0-generate-001", "imagen-4.0-fast-generate-001", "imagen-3.0-generate-002"];
        let resp, lastErr;
        for (const model of MODELS) {
          try { resp = await genai.models.generateImages({ model, prompt, config: { numberOfImages: 1 } }); break; }
          catch (err) { lastErr = err; if (!/NOT_FOUND|404|not found|not supported/i.test(err?.message || "")) break; }
        }
        const bytes = resp?.generatedImages?.[0]?.image?.imageBytes;
        if (!bytes) return `couldn't generate that image${lastErr ? ` (${lastErr.message})` : ""} — maybe try show_image (real photo) or send_gif`;
        const { AttachmentBuilder } = await import("discord.js");
        const attachment = new AttachmentBuilder(Buffer.from(bytes, "base64"), { name: "generated.png" });
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, message.guild);
        await message.channel.send({ ...(caption ? { content: caption } : {}), files: [attachment], allowedMentions });
        return `generated and posted an image for "${prompt}" — the user can see it, don't re-describe it`;
      } catch (e) {
        return `image generation failed: ${e.message}`;
      }
    }

    // Edit a photo the user attached, following their instruction, via a Gemini
    // multimodal image model (input image + text -> edited image), and post it.
    case "edit_image": {
      const instruction = input.instruction || input.prompt;
      if (!instruction) return "tell me what to change about the image";
      const attachment = message.attachments?.first();
      const url = input.url || input.image_url || attachment?.url;
      if (!url) return "no image attached — the user needs to attach the picture they want edited";
      if (!config.geminiKeys?.length) return "image editing isn't set up (no Gemini key)";
      try {
        const imgRes = await safeFetch(url, { binary: true, maxBytes: IMAGE_MAX_BYTES, timeoutMs: 10_000 });
        if (imgRes.status < 200 || imgRes.status >= 300) return `couldn't fetch the image: ${imgRes.status}`;
        if (!imgRes.bytes) return "couldn't fetch the image: empty response";
        const inB64 = imgRes.bytes.toString("base64");
        const inMime = imgRes.headers.get("content-type") || "image/png";

        const { GoogleGenAI } = await import("@google/genai");
        const genai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
        // Nano Banana family — multimodal image-out via generateContent. Newest
        // flash first, then older flash, then Pro (higher quality, slower/costlier).
        const MODELS = [config.geminiImageModel, "gemini-3.1-flash-image-preview", "gemini-2.5-flash-image", "gemini-3-pro-image-preview"].filter(Boolean);
        const seen = new Set();
        let outImg = null, lastErr;
        for (const model of MODELS) {
          if (seen.has(model)) continue; seen.add(model);
          try {
            const result = await genai.models.generateContent({
              model,
              contents: [{ role: "user", parts: [{ inlineData: { mimeType: inMime, data: inB64 } }, { text: instruction }] }],
              config: { responseModalities: ["TEXT", "IMAGE"] },
            });
            const parts = result?.candidates?.[0]?.content?.parts || [];
            const imgPart = parts.find((p) => p.inlineData?.data);
            if (imgPart) { outImg = imgPart.inlineData; break; }
          } catch (err) { lastErr = err; if (!/NOT_FOUND|404|not found|not supported/i.test(err?.message || "")) break; }
        }
        if (!outImg) return `couldn't edit the image${lastErr ? ` (${lastErr.message})` : ""} — the image model may not be available on this key (set GEMINI_IMAGE_MODEL)`;
        const { AttachmentBuilder } = await import("discord.js");
        const ext = (outImg.mimeType || "image/png").split("/")[1] || "png";
        const attachmentOut = new AttachmentBuilder(Buffer.from(String(outImg.data ?? ""), "base64"), { name: `edited.${ext}` });
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, message.guild);
        await message.channel.send({ ...(caption ? { content: caption } : {}), files: [attachmentOut], allowedMentions });
        return `edited the image (${instruction}) and posted the result — the user can see it`;
      } catch (e) {
        return `image edit failed: ${e.message}`;
      }
    }

    case "analyze_image": {
      const prompt = input.prompt || input.question || "Describe this image in detail.";
      const url = input.url || input.image_url;
      try {
        const visionOptions = {
          prompt,
          visionUrl: config.local?.ollamaVisionUrl,
          model: config.local?.ollamaVisionModel || "moondream",
          fallbackModel: config.local?.ollamaVisionFallbackModel || "moondream",
          maxImages: config.local?.visionMaxImages || 4,
          maxBytes: config.local?.visionImageMaxBytes || IMAGE_MAX_BYTES,
          visionTimeoutMs: config.local?.visionTimeoutMs ?? 30_000,
          maxTiles: config.local?.visionMaxTiles ?? 2,
          tileMinLongEdge: config.local?.visionTileMinLongEdge ?? 1600,
          tileMinAspect: config.local?.visionTileMinAspect ?? 1.45,
          tileOverlapRatio: config.local?.visionTileOverlapRatio ?? 0.12,
          detailMaxChars: config.local?.visionDetailMaxChars ?? 3600,
        };

        if (url) {
          const result = await describeImageAttachment({ url, name: "provided-url" }, visionOptions);
          return truncate(result.description || result.error || "could not analyze image");
        }

        const result = await describeImageAttachments(message, visionOptions);
        if (!result.allImageAttachments.length) return "no image provided — attach an image or provide a url";
        return truncate(formatImageDescriptions(result.imageDescriptions, { omittedCount: result.omittedCount }) || "could not analyze image", 2500);
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
        try { templates = JSON.parse(res.text || ""); }
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
            if (!buffer || buffer.length < 1000) throw new Error("Memegen returned tiny placeholder image");

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
          const imgurMatches = (imgurRes.text || "").match(/https:\/\/i\.imgur\.com\/[a-zA-Z0-9]+\.(jpg|png|gif|webp)/g) || [];
          images.push(...imgurMatches.slice(0, 3));
        } catch {}

        // Method 2: Know Your Meme (for meme templates specifically)
        try {
          const kymRes = await safeFetch(`https://knowyourmeme.com/search?q=${encodeURIComponent(query)}`, scrapeOpts);
          const kymMatches = (kymRes.text || "").match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)[^"'\s]*/gi) || [];
          const kymFiltered = kymMatches.filter(u => u.includes("kym-cdn") || u.includes("knowyourmeme")).slice(0, 3);
          images.push(...kymFiltered);
        } catch {}

        // Method 3: Imgflip (meme template database)
        try {
          const flipRes = await safeFetch(`https://imgflip.com/memesearch?q=${encodeURIComponent(query)}`, scrapeOpts);
          const flipHtml = flipRes.text;
          // Extract template page links and visit them for direct image
          const templateLinks = (flipHtml || "").match(/\/memetemplate\/\d+\/[^"'\s]+/g) || [];
          for (const link of templateLinks.slice(0, 2)) {
            try {
              const tplRes = await safeFetch(`https://imgflip.com${link}`, scrapeOpts);
              const tplHtml = tplRes.text;
              // Match both https:// and protocol-relative //i.imgflip.com URLs
              const directUrls = (tplHtml || "").match(/(?:https?:)?\/\/i\.imgflip\.com\/[^"'\s]+\.(?:jpg|png|webp)/gi) || [];
              for (const u of directUrls.slice(0, 2)) {
                images.push(u.startsWith("//") ? `https:${u}` : u);
              }
              if (images.length >= 3) break;
            } catch {}
          }
          // Also grab any direct i.imgflip.com URLs from search results page
          const flipDirect = (flipHtml || "").match(/(?:https?:)?\/\/i\.imgflip\.com\/[^"'\s]+\.(?:jpg|png)/gi) || [];
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
          const ddg = JSON.parse(ddgRes.text || "");
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
