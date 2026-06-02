// ─── Media Executor ─────────────────────────────────────────────────────────
//
// Posts real media into the channel: animated GIFs (Klipy), real photos
// (Wikipedia → Openverse), arbitrary downloadable files, AI-edited images
// (Gemini multimodal), plus the per-guild GIF embed-style toggle.

import { EmbedBuilder } from "discord.js";
import { safeFetch } from "@defnotean/shared/safeFetch";
import { isExplicitGifRequest, recordNaturalGif, shouldAllowNaturalGif } from "@defnotean/shared/gifCadence";
import { getGuildSettings, setGifEmbed } from "../../database.js";
import config from "../../config.js";
import { log } from "../../utils/logger.js";

const HANDLED = new Set([
  "send_gif", "show_image", "send_file", "edit_image", "set_gif_style",
]);

function resolveCaptionMentions(caption, guild) {
  const allowedUsers = new Set();
  let content = (caption || "").trim();
  if (content && guild) {
    content = content.replace(/@(\w+)/g, (match, name) => {
      const lower = name.toLowerCase();
      if (lower === "everyone" || lower === "here") return name;
      const predicate = m =>
        m.user.username.toLowerCase() === lower
        || m.displayName.toLowerCase() === lower
        || m.user.globalName?.toLowerCase() === lower;
      const matches = guild.members.cache.filter
        ? guild.members.cache.filter(predicate)
        : null;
      const member = matches
        ? (matches.size === 1 ? matches.first() : null)
        : guild.members.cache.find?.(predicate);
      if (!member) return match;
      allowedUsers.add(member.id);
      return `<@${member.id}>`;
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

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  switch (toolName) {
    case "send_gif": {
      const klipyKey = config.klipyApiKey;
      if (!klipyKey) return "couldn't send a GIF right now. Continue naturally without mentioning internal setup.";
      const gifScope = `${guild?.id || "dm"}:${message.channel?.id || "dm"}`;
      const explicitGif = isExplicitGifRequest(`${message.content || ""} ${input.caption || ""}`);
      if (!explicitGif) {
        const cadence = shouldAllowNaturalGif(gifScope);
        if (!cadence.allowed) return "natural GIF skipped: cooldown active. Reply with text instead and do not mention the cooldown.";
      }
      const q = encodeURIComponent(input.query || "meme");
      let json;
      try {
        const res = await safeFetch(
          `https://api.klipy.com/api/v1/${klipyKey}/gifs/search?q=${q}&per_page=20&content_filter=medium&customer_id=${message.author.id}`,
          { maxBytes: 2_000_000, timeoutMs: 8_000 }
        );
        if (res.status < 200 || res.status >= 300) {
          return "couldn't find a usable GIF right now. Continue naturally without mentioning the GIF service.";
        }
        json = JSON.parse(res.text || "{}");
      } catch (err) {
        log(`[GIF] Search failed for "${input.query || "meme"}": ${err?.message || err}`);
        return "couldn't find a usable GIF right now. Continue naturally without mentioning the GIF service.";
      }
      const results = json?.data?.data;
      if (!results?.length) return `couldn't find a GIF for "${input.query}". Continue naturally without mentioning the GIF service.`;
      const pick = results[Math.floor(Math.random() * Math.min(results.length, 10))];
      const gifUrl = pick.file?.hd?.gif?.url ?? pick.file?.md?.gif?.url ?? pick.file?.sm?.gif?.url ?? null;
      if (!gifUrl) return "couldn't find a usable GIF right now. Continue naturally without mentioning the GIF service.";

      const gifSettings = guild ? getGuildSettings(guild.id) : {};
      const useEmbed = gifSettings?.gif_embed !== false;

      {
        const color = useEmbed ? 0xFFFFFF : 0x2b2d31;
        const embed = new EmbedBuilder().setImage(gifUrl).setColor(color);
        const { content: resolvedCaption, allowedMentions } = resolveCaptionMentions(input.caption, guild);
        const sendOpts = resolvedCaption
          ? { content: resolvedCaption, embeds: [embed], allowedMentions }
          : { embeds: [embed], allowedMentions };
        try {
          await message.channel.send(sendOpts);
        } catch (err) {
          log(`[GIF] Embed send failed: ${err.message} — falling back to URL`);
          const fallback = resolvedCaption ? `${resolvedCaption}\n${gifUrl}` : gifUrl;
          const sent = await message.channel.send({ content: fallback, allowedMentions }).then(() => true).catch(() => false);
          if (!sent) return "couldn't send a GIF right now. Continue naturally without mentioning the send failure.";
        }
      }
      if (!explicitGif) recordNaturalGif(gifScope);
      return `sent GIF for "${input.query}"`;
    }

    // Find a REAL photo of a subject and POST it inline with the bot's caption.
    // Free, no API key: Wikipedia (best for "what does X look like") → Openverse
    // (CC image search) fallback. Mirrors send_gif's embed-and-send pattern.
    case "show_image": {
      const query = input.query || input.search || input.q;
      if (!query) return "no image query provided";
      const q = encodeURIComponent(query);
      const fetchOpts = { headers: { "User-Agent": "Mozilla/5.0 (compatible; irene-bot/2 image lookup)" }, maxBytes: 2_000_000, timeoutMs: 6_000 };
      let imageUrl = null;
      let source = null;

      // Source 1: Wikipedia — search for the best page, then grab its lead image.
      try {
        const sr = await safeFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=1&format=json&origin=*`, fetchOpts);
        const title = JSON.parse(sr.text || "{}")?.query?.search?.[0]?.title;
        if (title) {
          const pr = await safeFetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&piprop=original%7Cthumbnail&pithumbsize=800&format=json&origin=*`, fetchOpts);
          const pages = JSON.parse(pr.text || "{}")?.query?.pages || {};
          const page = Object.values(pages)[0];
          const candidate = page?.original?.source || page?.thumbnail?.source || null;
          if (candidate && !/\.svg(\?|$)/i.test(candidate)) { imageUrl = candidate; source = "wikipedia"; }
        }
      } catch (e) {
        // Best-effort: fall through to the next image source on any failure.
        log(`[Executor] Wikipedia image lookup failed for "${query}": ${e?.message || e}`);
      }

      // Source 2: Openverse — free CC image search, no key, broader coverage.
      if (!imageUrl) {
        try {
          const or = await safeFetch(`https://api.openverse.org/v1/images/?q=${q}&page_size=5&mature=false`, fetchOpts);
          const item = (JSON.parse(or.text || "{}")?.results || []).find((/** @type {any} */ r) => r.url && !/\.svg(\?|$)/i.test(r.url));
          if (item) { imageUrl = item.url || item.thumbnail; source = "openverse"; }
        } catch (e) {
          // Best-effort: no image found is handled below.
          log(`[Executor] Openverse image lookup failed for "${query}": ${e?.message || e}`);
        }
      }

      if (!imageUrl) return `couldn't find a good photo of "${query}" — tell the user in your own words (maybe describe it instead)`;

      const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, guild);
      try {
        const embed = new EmbedBuilder().setImage(imageUrl).setColor(config.colors?.gif || 0x2b2d31);
        await message.channel.send({
          ...(caption ? { content: caption } : {}),
          embeds: [embed],
          allowedMentions,
        });
        return `posted a real photo of "${query}" (via ${source}) with your caption — the user can see the image now, so don't re-describe what's in it`;
      } catch (e) {
        log(`[show_image] send failed: ${e.message} — falling back to URL`);
        try { await message.channel.send({ content: caption ? `${caption}\n${imageUrl}` : imageUrl, allowedMentions }); return `posted image URL for "${query}"`; }
        catch (e2) { return `found an image but couldn't post it: ${e2.message}`; }
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
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, guild);
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
        const imgRes = await safeFetch(url, { binary: true, maxBytes: 8_000_000, timeoutMs: 10_000 });
        if (imgRes.status < 200 || imgRes.status >= 300) return `couldn't fetch the image: ${imgRes.status}`;
        if (!imgRes.bytes) return "couldn't read the image data";
        const inB64 = imgRes.bytes.toString("base64");
        const inMime = imgRes.headers.get("content-type") || "image/png";

        const { GoogleGenAI } = await import("@google/genai");
        const genai = new GoogleGenAI({ apiKey: config.geminiKeys[0] });
        // Nano Banana family — newest flash first, then older flash, then Pro.
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
        if (!outImg?.data) return `couldn't edit the image${lastErr ? ` (${lastErr.message})` : ""} — the image model may not be available on this key (set GEMINI_IMAGE_MODEL)`;
        const { AttachmentBuilder } = await import("discord.js");
        const ext = (outImg.mimeType || "image/png").split("/")[1] || "png";
        const attachmentOut = new AttachmentBuilder(Buffer.from(outImg.data, "base64"), { name: `edited.${ext}` });
        const { content: caption, allowedMentions } = resolveCaptionMentions(input.caption, guild);
        await message.channel.send({ ...(caption ? { content: caption } : {}), files: [attachmentOut], allowedMentions });
        return `edited the image (${instruction}) and posted the result — the user can see it`;
      } catch (e) {
        return `image edit failed: ${e.message}`;
      }
    }

    case "set_gif_style": {
      const mode = input.style?.toLowerCase();
      if (mode === "raw" || mode === "clean" || mode === "plain") {
        setGifEmbed(guild.id, false);
        return "GIF style → **raw** — no embed border, just the GIF";
      } else if (mode === "embed" || mode === "border" || mode === "fancy") {
        setGifEmbed(guild.id, true);
        return "GIF style → **embed** — GIFs show with a colored border";
      }
      return `use "raw" (no border) or "embed" (with border)`;
    }
  }
}
