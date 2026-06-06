// ─── Audio / TTS / Image Generation Executor ───────────────────────────────

import { getTtsChannels, setTtsChannels } from "../../database.js";
import { log } from "../../utils/logger.js";
import config from "../../config.js";
import { GoogleGenAI } from "@google/genai";
import { ChannelType } from "discord.js";

// Gemini client for image generation (round-robin across available keys)
const _imageClients = config.geminiKeys?.filter(Boolean).map((k, idx) => ({
  label: `key #${idx + 1}`,
  client: new GoogleGenAI({ apiKey: k }),
})) ?? [];
let _imageKeyIdx = 0;
function getImageClients() {
  if (_imageClients.length === 0) return [];
  const start = _imageKeyIdx % _imageClients.length;
  _imageKeyIdx++;
  return _imageClients.map((_, offset) => _imageClients[(start + offset) % _imageClients.length]);
}

function imageErrorMessage(err) {
  return err?.message || String(err || "unknown error");
}

function briefImageError(msg) {
  return String(msg).replace(/\s+/g, " ").slice(0, 240);
}

function isUnsupportedImageModelError(msg) {
  return /NOT_FOUND|404|is not found|not found|is not supported|unsupported/i.test(msg);
}

function isSafetyImageError(msg) {
  return /safety|blocked|policy|prohibited|responsible ai/i.test(msg);
}

function isTransientImageError(msg) {
  return /503|UNAVAILABLE|RESOURCE_EXHAUSTED|429|rate.?limit|quota|timeout|timed out|fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(msg);
}

const HANDLED = new Set([
  "toggle_tts", "set_tts_voice", "say_tts", "generate_image",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  switch (toolName) {
    case "toggle_tts": {
      let vc = null;

      if (input.channel_name) {
        // Accept both regular voice (2) AND stage channels (13) — stage
        // channels are also voice, and the old hardcoded `=== 2` silently
        // refused TTS toggle on them.
        vc = guild.channels.cache.find(
          (c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
              && c.name.toLowerCase() === input.channel_name.toLowerCase()
        );
        if (!vc) return `Voice channel "${input.channel_name}" not found`;
      } else {
        const member = message.member;
        if (member?.voice?.channel) {
          vc = member.voice.channel;
        } else {
          return "join a VC first or tell me which one";
        }
      }

      const channels = getTtsChannels(guild.id);
      if (input.enabled) {
        // Auto-join the VC before saving the setting so failures don't leave
        // TTS "enabled" but silent.
        const { getQueue, createQueue, connectToChannel } = await import("../../music/player.js");
        let q = getQueue(guild.id);
        if (q?.voiceChannel?.id && q.voiceChannel.id !== vc.id) {
          return `i'm already connected to **${q.voiceChannel.name || "another VC"}**. move me/stop music first, then enable TTS in **${vc.name}**`;
        }
        try {
          if (!q) {
            q = createQueue(guild.id, vc, message.channel);
            await connectToChannel(q);
          } else if (!q.player) {
            await connectToChannel(q);
          }
        } catch (err) {
          log(`[TTS] Failed to join ${vc.id}: ${err?.message || err}`);
          return `couldn't enable TTS in **${vc.name}**: ${err?.message || err}`;
        }

        if (!channels.includes(vc.id)) channels.push(vc.id);
        setTtsChannels(guild.id, channels);
        return `TTS enabled in **${vc.name}** — i've joined and will read messages out loud. type in the VC chat and i'll speak it`;
      } else {
        const filtered = channels.filter((id) => id !== vc.id);
        setTtsChannels(guild.id, filtered);
        if (filtered.length === 0) {
          const { getQueue, deleteQueue } = await import("../../music/player.js");
          const q = getQueue(guild.id);
          if (q && !q.playing) deleteQueue(guild.id);
        }
        return `TTS disabled in **${vc.name}**`;
      }
    }

    case "set_tts_voice": {
      const VOICES = ["Kore","Puck","Charon","Zephyr","Fenrir","Enceladus","Algieba","Despina","Leda","Aoede","Callirrhoe","Umbriel","Tethys","Proteus","Ariel"];
      const voice = input.voice?.trim();
      const match = VOICES.find((v) => v.toLowerCase() === voice?.toLowerCase());
      if (!match) return `unknown voice "${voice}" — available: ${VOICES.join(", ")}`;
      const { setTtsVoice } = await import("../../database.js");
      setTtsVoice(guild.id, match);
      return `TTS voice changed to **${match}** ✓`;
    }

    case "say_tts": {
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      const vc = member?.voice?.channel;
      if (!vc) return "you need to be in a voice channel for me to speak";

      const { playTTS } = await import("../../music/player.js");
      await playTTS(guild.id, input.text, vc, message.channel);
      return `speaking: "${input.text.slice(0, 100)}"`;
    }

    case "generate_image": {
      const imageClients = getImageClients();
      if (imageClients.length === 0) return "image generation is not available — no Gemini API keys configured";

      const prompt = input.prompt;
      if (!prompt || prompt.length < 3) return "please provide a longer description of the image you want";

      // Chat image requests should prefer the low-latency model, then fall back
      // to higher quality / older models if the provider rejects or stalls.
      const IMAGE_MODELS = [
        "imagen-4.0-fast-generate-001",
        "imagen-4.0-generate-001",
        "imagen-3.0-generate-002",
      ];

      let response;
      let lastErr;
      let blockedBySafety = false;
      const imagePrompt = input.style ? `${input.style} style: ${prompt}` : prompt;

      image_attempts:
      for (const model of IMAGE_MODELS) {
        for (const { client, label } of imageClients) {
          try {
            response = await client.models.generateImages({
              model,
              prompt: imagePrompt,
              config: { numberOfImages: 1 },
            });
            break image_attempts;
          } catch (err) {
            lastErr = err;
            const msg = imageErrorMessage(err);
            const brief = briefImageError(msg);

            if (isSafetyImageError(msg)) {
              blockedBySafety = true;
              log(`[ImageGen] ${model} blocked by safety filters`);
              break image_attempts;
            }

            if (isUnsupportedImageModelError(msg)) {
              log(`[ImageGen] ${model} unavailable on ${label} — trying next fallback`);
              break;
            }

            if (isTransientImageError(msg)) {
              log(`[ImageGen] ${model} transient failure on ${label}: ${brief} — trying next key/model`);
              continue;
            }

            log(`[ImageGen] ${model} failed on ${label}: ${brief}`);
            break image_attempts;
          }
        }
      }

      if (!response) {
        const errMsg = imageErrorMessage(lastErr);
        const brief = briefImageError(errMsg);
        log(`[ImageGen] All image attempts failed: ${brief}`);
        if (blockedBySafety || isSafetyImageError(errMsg)) {
          return "the image was blocked by safety filters — try a different prompt";
        }
        if (isTransientImageError(errMsg)) {
          return "image generation is temporarily unavailable on Google's side right now. tell the user it failed upstream and do not call generate_image again this turn";
        }
        return `image generation failed: ${brief}. tell the user it failed and do not call generate_image again this turn`;
      }

      try {
        if (!response.generatedImages || response.generatedImages.length === 0) {
          return "the image model couldn't generate that — it may have been flagged by safety filters. try rephrasing your prompt";
        }

        // Defensive access — Gemini API occasionally returns shapes where
        // image or imageBytes is missing (partial response, rate-limit, etc).
        // Old code would throw on the .image.imageBytes chain and surface as
        // a generic "image generation failed" via the outer catch.
        const imageBytes = response.generatedImages[0]?.image?.imageBytes;
        if (!imageBytes) {
          return "the image model returned an empty result. try again or rephrase";
        }
        const buffer = Buffer.from(imageBytes, "base64");

        const { AttachmentBuilder } = await import("discord.js");
        const attachment = new AttachmentBuilder(buffer, { name: "generated.png" });

        await message.channel.send({
          content: `**${prompt}**`,
          files: [attachment],
        });

        return `generated and sent an image for "${prompt}"`;
      } catch (err) {
        log(`[ImageGen] Send failed: ${err.message}`);
        return `image generation failed while sending the result: ${err.message}. tell the user it failed and do not call generate_image again this turn`;
      }
    }
  }
}
