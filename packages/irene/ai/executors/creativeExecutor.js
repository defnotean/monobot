import { AttachmentBuilder } from "discord.js";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { safeFetch } from "@defnotean/shared/safeFetch";
import {
  elevenLabsAudioIsolation,
  elevenLabsSoundEffect,
  elevenLabsSpeechToText,
  elevenLabsTextToDialogue,
} from "@defnotean/shared/elevenLabs";
import {
  buildHiggsfieldPayload,
  runHiggsfieldCommand,
} from "@defnotean/shared/higgsfieldBridge";

const HANDLED = new Set([
  "generate_sound_effect",
  "generate_dialogue_audio",
  "clean_audio_attachment",
  "transcribe_audio_attachment",
  "higgsfield_generate_video",
  "higgsfield_animate_image",
  "higgsfield_make_shorts",
  "higgsfield_train_character",
  "higgsfield_score_video",
]);

const MAX_FETCH_BYTES = 50 * 1024 * 1024;
const MAX_DISCORD_FILE_BYTES = 24 * 1024 * 1024;

function ensureElevenLabs() {
  if (!config.elevenLabs?.apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }
}

function safeName(name, fallback) {
  const clean = String(name || fallback || "audio")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || fallback || "audio";
}

function extFromContentType(contentType, fallback = "mp3") {
  if (/wav|wave/i.test(contentType)) return "wav";
  if (/ogg|opus/i.test(contentType)) return "ogg";
  if (/mpeg|mp3/i.test(contentType)) return "mp3";
  if (/mp4/i.test(contentType)) return "mp4";
  return fallback;
}

function getFirstAttachment(message, input = {}, kind = "audio") {
  if (input.attachment_url || input.url || input.source_url) {
    return {
      url: input.attachment_url || input.url || input.source_url,
      name: input.filename || `${kind}.bin`,
      contentType: input.mime_type || input.content_type || "application/octet-stream",
    };
  }
  const attachments = [...(message.attachments?.values?.() || [])];
  if (!attachments.length) return null;
  return attachments.find((att) => {
    const type = String(att.contentType || "");
    if (kind === "image") return type.startsWith("image/");
    if (kind === "video") return type.startsWith("video/");
    return type.startsWith("audio/") || type.startsWith("video/");
  }) || attachments[0];
}

async function fetchAttachment(message, input, kind = "audio") {
  const attachment = getFirstAttachment(message, input, kind);
  if (!attachment?.url) throw new Error(`attach or link a ${kind} file first`);
  const res = await safeFetch(attachment.url, {
    binary: true,
    maxBytes: MAX_FETCH_BYTES,
    timeoutMs: config.elevenLabs?.timeoutMs || 60_000,
  });
  return {
    buffer: res.bytes,
    filename: safeName(attachment.name, `${kind}.bin`),
    mimeType: attachment.contentType || res.headers?.get?.("content-type") || "application/octet-stream",
    url: attachment.url,
  };
}

async function sendBuffer(message, { buffer, contentType, filename, content }) {
  if (!buffer?.length) throw new Error("provider returned empty audio");
  if (buffer.length > MAX_DISCORD_FILE_BYTES) {
    return `generated file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, which is too large to upload to Discord here`;
  }
  const attachment = new AttachmentBuilder(buffer, { name: filename });
  await message.channel.send({ content, files: [attachment] });
  return `sent ${filename}`;
}

function resolveVoiceId(voice) {
  const requested = String(voice || "").trim();
  const map = config.elevenLabs?.voiceMap || {};
  return map[requested]
    || map[requested.toLowerCase?.()]
    || (/^[A-Za-z0-9_-]{10,}$/.test(requested) ? requested : null)
    || config.elevenLabs?.voiceId;
}

function dialogueInputs(lines) {
  const rawLines = Array.isArray(lines) ? lines : [];
  const inputs = rawLines.map((line) => ({
    text: String(line?.text || line?.line || "").trim(),
    voice_id: resolveVoiceId(line?.voice_id || line?.voiceId || line?.voice || line?.speaker),
  })).filter((line) => line.text && line.voice_id);
  if (!inputs.length) throw new Error("provide at least one dialogue line with text");
  return inputs;
}

function formatTranscript(stt) {
  const text = String(stt?.text || "").trim();
  if (!text) return "no speech detected";
  return text.length > 1800 ? `${text.slice(0, 1800)}...` : text;
}

function isSafeOutputFile(filePath) {
  const root = resolve(config.higgsfield?.outputDir || "/tmp/monobot-higgsfield");
  const full = resolve(String(filePath || ""));
  return full === root || full.startsWith(`${root}${sep}`);
}

async function postHiggsfieldResult(message, title, result) {
  const urls = [
    result?.url,
    ...(Array.isArray(result?.urls) ? result.urls : []),
    ...(Array.isArray(result?.assets) ? result.assets.map((a) => a?.url).filter(Boolean) : []),
  ].filter(Boolean);
  const files = [
    result?.file,
    ...(Array.isArray(result?.files) ? result.files : []),
    ...(Array.isArray(result?.assets) ? result.assets.map((a) => a?.file || a?.path).filter(Boolean) : []),
  ].filter(Boolean);

  const attachable = [];
  for (const file of files) {
    if (!isSafeOutputFile(file) || !existsSync(file)) continue;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_DISCORD_FILE_BYTES) continue;
    attachable.push(new AttachmentBuilder(file));
  }

  const lines = [
    `**${title}**`,
    result?.message,
    ...urls,
    result?.warning ? `warning: ${result.warning}` : null,
  ].filter(Boolean);

  if (attachable.length) {
    await message.channel.send({ content: lines.join("\n").slice(0, 1900), files: attachable.slice(0, 3) });
    return `sent Higgsfield result (${attachable.length} file${attachable.length === 1 ? "" : "s"})`;
  }
  if (lines.length > 1) {
    await message.channel.send(lines.join("\n").slice(0, 1900));
    return "sent Higgsfield result";
  }
  return "Higgsfield job completed, but the wrapper did not return a file or URL";
}

async function runHiggsfield(action, input, message, title) {
  const payload = buildHiggsfieldPayload(action, input);
  const result = await runHiggsfieldCommand({
    command: config.higgsfield?.command,
    payload,
    timeoutMs: config.higgsfield?.timeoutMs,
  });
  return postHiggsfieldResult(message, title, result);
}

export async function execute(toolName, input, message) {
  if (!HANDLED.has(toolName)) return undefined;

  try {
    switch (toolName) {
      case "generate_sound_effect": {
        ensureElevenLabs();
        const result = await elevenLabsSoundEffect({
          apiKey: config.elevenLabs.apiKey,
          baseUrl: config.elevenLabs.baseUrl,
          text: input.prompt || input.text,
          durationSeconds: input.duration_seconds,
          promptInfluence: input.prompt_influence,
          outputFormat: config.elevenLabs.outputFormat,
          timeoutMs: config.elevenLabs.timeoutMs,
        });
        const ext = extFromContentType(result.contentType, "mp3");
        return sendBuffer(message, {
          ...result,
          filename: `${safeName(input.name, "sound-effect")}.${ext}`,
          content: `sound effect: **${String(input.prompt || input.text).slice(0, 120)}**`,
        });
      }

      case "generate_dialogue_audio": {
        ensureElevenLabs();
        const result = await elevenLabsTextToDialogue({
          apiKey: config.elevenLabs.apiKey,
          baseUrl: config.elevenLabs.baseUrl,
          inputs: dialogueInputs(input.lines),
          modelId: config.elevenLabs.dialogueModel,
          outputFormat: config.elevenLabs.outputFormat,
          timeoutMs: config.elevenLabs.timeoutMs,
        });
        const ext = extFromContentType(result.contentType, "mp3");
        return sendBuffer(message, {
          ...result,
          filename: `${safeName(input.name, "dialogue")}.${ext}`,
          content: "dialogue audio",
        });
      }

      case "clean_audio_attachment": {
        ensureElevenLabs();
        const audio = await fetchAttachment(message, input, "audio");
        const result = await elevenLabsAudioIsolation({
          apiKey: config.elevenLabs.apiKey,
          baseUrl: config.elevenLabs.baseUrl,
          audioBuffer: audio.buffer,
          filename: audio.filename,
          mimeType: audio.mimeType,
          timeoutMs: config.elevenLabs.timeoutMs,
        });
        const ext = extFromContentType(result.contentType, "wav");
        return sendBuffer(message, {
          ...result,
          filename: `${safeName(input.name, "cleaned-audio")}.${ext}`,
          content: "cleaned audio",
        });
      }

      case "transcribe_audio_attachment": {
        ensureElevenLabs();
        const audio = input.source_url
          ? { url: input.source_url, buffer: null, filename: "source-url", mimeType: "audio/wav" }
          : await fetchAttachment(message, input, "audio");
        const stt = await elevenLabsSpeechToText({
          apiKey: config.elevenLabs.apiKey,
          baseUrl: config.elevenLabs.baseUrl,
          sourceUrl: input.source_url,
          audioBuffer: audio.buffer,
          filename: audio.filename,
          mimeType: audio.mimeType,
          modelId: config.elevenLabs.sttModel,
          languageCode: input.language_code,
          diarize: !!input.diarize,
          numSpeakers: input.num_speakers,
          tagAudioEvents: input.tag_audio_events !== false,
          timeoutMs: config.elevenLabs.timeoutMs,
        });
        return `transcript:\n${formatTranscript(stt)}`;
      }

      case "higgsfield_generate_video":
        return runHiggsfield("generate_video", input, message, "Higgsfield video");
      case "higgsfield_animate_image":
        return runHiggsfield("animate_image", input, message, "Higgsfield animation");
      case "higgsfield_make_shorts":
        return runHiggsfield("make_shorts", input, message, "Higgsfield shorts");
      case "higgsfield_train_character":
        return runHiggsfield("train_character", input, message, "Higgsfield character");
      case "higgsfield_score_video":
        return runHiggsfield("score_video", input, message, "Higgsfield score");
    }
  } catch (err) {
    const msg = err?.message || String(err);
    log(`[Creative] ${toolName} failed: ${msg}`);
    return `${toolName} failed: ${msg}`;
  }

  return undefined;
}
