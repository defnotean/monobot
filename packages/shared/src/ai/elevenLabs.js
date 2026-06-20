const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @typedef {{ baseUrl?: string, method?: string, headers?: Record<string, string>, body?: BodyInit, timeoutMs?: number }} ElevenRequestOptions
 * @typedef {{ buffer: Buffer, contentType: string, filename: string }} ElevenAudioResult
 * @typedef {{ apiKey?: string, text?: string, voiceId?: string, modelId?: string, outputFormat?: string, voiceSettings?: Record<string, any>, baseUrl?: string, timeoutMs?: number }} ElevenTtsOptions
 * @typedef {{ text?: string, voice_id?: string, voiceId?: string }} ElevenDialogueInput
 * @typedef {{ apiKey?: string, inputs?: ElevenDialogueInput[], modelId?: string, outputFormat?: string, baseUrl?: string, timeoutMs?: number }} ElevenDialogueOptions
 * @typedef {{ apiKey?: string, audioBuffer?: Buffer|null, sourceUrl?: string, filename?: string, mimeType?: string, modelId?: string, languageCode?: string, diarize?: boolean, numSpeakers?: number, tagAudioEvents?: boolean, useMultiChannel?: boolean, baseUrl?: string, timeoutMs?: number }} ElevenSttOptions
 * @typedef {{ apiKey?: string, audioBuffer?: Buffer, filename?: string, mimeType?: string, baseUrl?: string, timeoutMs?: number }} ElevenIsolationOptions
 * @typedef {{ apiKey?: string, text?: string, durationSeconds?: number, promptInfluence?: number, outputFormat?: string, baseUrl?: string, timeoutMs?: number }} ElevenSoundEffectOptions
 */

/** @param {string | undefined} apiKey */
function assertApiKey(apiKey) {
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
}

/** @param {Headers | undefined} headers @param {string} [fallback] */
function contentTypeFrom(headers, fallback = "application/octet-stream") {
  return headers?.get?.("content-type")?.split(";")[0]?.trim() || fallback;
}

/** @param {string} contentType @param {string} [fallback] */
function filenameFor(contentType, fallback = "audio.mp3") {
  if (/wav|wave/i.test(contentType)) return "audio.wav";
  if (/ogg|opus/i.test(contentType)) return "audio.ogg";
  if (/mpeg|mp3/i.test(contentType)) return "audio.mp3";
  return fallback;
}

/** @param {Response} res */
async function readError(res) {
  const text = await res.text().catch(() => "");
  const compact = text.replace(/\s+/g, " ").slice(0, 300);
  return compact || `${res.status} ${res.statusText}`;
}

/** @param {string | undefined} apiKey @param {string} path @param {ElevenRequestOptions} [options] */
async function request(apiKey, path, {
  baseUrl = DEFAULT_BASE_URL,
  method = "POST",
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  assertApiKey(apiKey);
  const requestHeaders = /** @type {HeadersInit} */ ({
    "xi-api-key": String(apiKey),
    ...headers,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await readError(res)}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Record<string, any>} value */
function jsonBody(value) {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

/** @param {FormData} form @param {string} key @param {any} value */
function appendMaybe(form, key, value) {
  if (value === undefined || value === null || value === "") return;
  form.append(key, String(value));
}

/** @param {FormData} form @param {string} key @param {Buffer} buffer @param {{ filename?: string, mimeType?: string }} [options] */
function appendFile(form, key, buffer, { filename = "audio.wav", mimeType = "audio/wav" } = {}) {
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  form.append(key, blob, filename);
}

/** @param {ElevenTtsOptions} [options] @returns {Promise<ElevenAudioResult>} */
export async function elevenLabsTextToSpeech({
  apiKey,
  text,
  voiceId,
  modelId = "eleven_multilingual_v2",
  outputFormat = "mp3_44100_128",
  voiceSettings,
  baseUrl,
  timeoutMs,
} = {}) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  if (!voiceId) throw new Error("ElevenLabs voice id is required");
  const path = `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const res = await request(apiKey, path, {
    baseUrl,
    timeoutMs,
    ...jsonBody({
      text: String(text).slice(0, 5_000),
      model_id: modelId,
      ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
    }),
  });
  const contentType = contentTypeFrom(res.headers, outputFormat.includes("wav") ? "audio/wav" : "audio/mpeg");
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType,
    filename: filenameFor(contentType, "speech.mp3"),
  };
}

/** @param {ElevenDialogueOptions} [options] @returns {Promise<ElevenAudioResult>} */
export async function elevenLabsTextToDialogue({
  apiKey,
  inputs,
  modelId = "eleven_v3",
  outputFormat = "mp3_44100_128",
  baseUrl,
  timeoutMs,
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("inputs are required");
  const cleanInputs = inputs
    .map((entry) => ({
      text: String(entry?.text || "").slice(0, 1_000),
      voice_id: String(entry?.voice_id || entry?.voiceId || ""),
    }))
    .filter((entry) => entry.text && entry.voice_id);
  if (!cleanInputs.length) throw new Error("at least one dialogue line needs text and voice_id");
  const res = await request(apiKey, `/text-to-dialogue?output_format=${encodeURIComponent(outputFormat)}`, {
    baseUrl,
    timeoutMs,
    ...jsonBody({ inputs: cleanInputs, model_id: modelId }),
  });
  const contentType = contentTypeFrom(res.headers, outputFormat.includes("wav") ? "audio/wav" : "audio/mpeg");
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType,
    filename: filenameFor(contentType, "dialogue.mp3"),
  };
}

/** @param {ElevenSttOptions} [options] @returns {Promise<any>} */
export async function elevenLabsSpeechToText({
  apiKey,
  audioBuffer,
  sourceUrl,
  filename = "audio.wav",
  mimeType = "audio/wav",
  modelId = "scribe_v2",
  languageCode,
  diarize = false,
  numSpeakers,
  tagAudioEvents = true,
  useMultiChannel = false,
  baseUrl,
  timeoutMs,
} = {}) {
  if (!audioBuffer && !sourceUrl) throw new Error("audioBuffer or sourceUrl is required");
  const form = new FormData();
  form.append("model_id", modelId);
  appendMaybe(form, "language_code", languageCode);
  appendMaybe(form, "diarize", diarize);
  appendMaybe(form, "tag_audio_events", tagAudioEvents);
  appendMaybe(form, "use_multi_channel", useMultiChannel);
  appendMaybe(form, "num_speakers", numSpeakers);
  if (sourceUrl) form.append("source_url", String(sourceUrl));
  else if (audioBuffer) appendFile(form, "file", audioBuffer, { filename, mimeType });
  const res = await request(apiKey, "/speech-to-text", {
    baseUrl,
    body: form,
    timeoutMs,
  });
  return res.json();
}

/** @param {ElevenIsolationOptions} [options] @returns {Promise<ElevenAudioResult>} */
export async function elevenLabsAudioIsolation({
  apiKey,
  audioBuffer,
  filename = "audio.wav",
  mimeType = "audio/wav",
  baseUrl,
  timeoutMs,
} = {}) {
  if (!audioBuffer) throw new Error("audioBuffer is required");
  const form = new FormData();
  appendFile(form, "audio", audioBuffer, { filename, mimeType });
  const res = await request(apiKey, "/audio-isolation", {
    baseUrl,
    body: form,
    timeoutMs,
  });
  const contentType = contentTypeFrom(res.headers, "audio/wav");
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType,
    filename: filenameFor(contentType, "isolated.wav"),
  };
}

/** @param {ElevenSoundEffectOptions} [options] @returns {Promise<ElevenAudioResult>} */
export async function elevenLabsSoundEffect({
  apiKey,
  text,
  durationSeconds,
  promptInfluence,
  outputFormat = "mp3_44100_128",
  baseUrl,
  timeoutMs,
} = {}) {
  if (!text || !String(text).trim()) throw new Error("text is required");
  const res = await request(apiKey, `/sound-generation?output_format=${encodeURIComponent(outputFormat)}`, {
    baseUrl,
    timeoutMs,
    ...jsonBody({
      text: String(text).slice(0, 500),
      ...(durationSeconds ? { duration_seconds: Number(durationSeconds) } : {}),
      ...(promptInfluence !== undefined ? { prompt_influence: Number(promptInfluence) } : {}),
    }),
  });
  const contentType = contentTypeFrom(res.headers, "audio/mpeg");
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType,
    filename: filenameFor(contentType, "sound-effect.mp3"),
  };
}
