// ─── Audio / TTS / Image Generation Executor ───────────────────────────────

import { getTtsChannels, setTtsChannels } from "../../database.js";
import { log } from "../../utils/logger.js";
import config from "../../config.js";
import { GoogleGenAI } from "@google/genai";
import { ChannelType } from "discord.js";

// Gemini client for image generation (round-robin across available keys)
const _imageClients = config.geminiKeys?.filter(Boolean).map((k) => new GoogleGenAI({ apiKey: k })) ?? [];
let _imageKeyIdx = 0;
function getImageClient() {
  if (_imageClients.length === 0) return null;
  const client = _imageClients[_imageKeyIdx % _imageClients.length];
  _imageKeyIdx++;
  return client;
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
        if (!channels.includes(vc.id)) channels.push(vc.id);
        setTtsChannels(guild.id, channels);

        // Auto-join the VC so TTS can work immediately
        const { getQueue, createQueue, connectToChannel } = await import("../../music/player.js");
        if (!getQueue(guild.id)) {
          const q = createQueue(guild.id, vc, message.channel);
          await connectToChannel(q).catch(() => {});
        }

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
      const client = getImageClient();
      if (!client) return "image generation is not available — no Gemini API keys configured";

      const prompt = input.prompt;
      if (!prompt || prompt.length < 3) return "please provide a longer description of the image you want";

      // Model fallback chain — imagen-3.0-generate-001 was deprecated (404 in v1beta)
      // Try newest first, then fall back to older models
      const IMAGE_MODELS = [
        "imagen-4.0-generate-001",
        "imagen-4.0-fast-generate-001",
        "imagen-3.0-generate-002",
      ];

      let response;
      let lastErr;
      for (const model of IMAGE_MODELS) {
        try {
          response = await client.models.generateImages({
            model,
            prompt: input.style ? `${input.style} style: ${prompt}` : prompt,
            config: { numberOfImages: 1 },
          });
          break; // success
        } catch (err) {
          lastErr = err;
          // Only fall through on 404 / NOT_FOUND. Other errors (safety, quota) should stop.
          const msg = err?.message || String(err);
          if (!/NOT_FOUND|404|is not found|is not supported/i.test(msg)) break;
          log(`[ImageGen] ${model} unavailable — trying next fallback`);
        }
      }

      if (!response) {
        const errMsg = lastErr?.message || "unknown error";
        log(`[ImageGen] All models failed: ${errMsg}`);
        if (errMsg.includes("safety") || errMsg.includes("blocked")) {
          return "the image was blocked by safety filters — try a different prompt";
        }
        return `image generation failed: ${errMsg}. suggest a GIF instead using send_gif`;
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
        return `image generation failed: ${err.message}. suggest a GIF instead using send_gif`;
      }
    }
  }
}
