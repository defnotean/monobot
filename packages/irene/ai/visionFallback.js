import { GoogleGenAI } from "@google/genai";
import config from "../config.js";
import { log } from "../utils/logger.js";

const clients = (config.geminiKeys || []).map((apiKey) => new GoogleGenAI({ apiKey }));
let clientIndex = 0;

function nextClient() {
  if (!clients.length) return null;
  const client = clients[clientIndex % clients.length];
  clientIndex += 1;
  return client;
}

function extractText(response) {
  return response?.candidates?.[0]?.content?.parts
    ?.filter((part) => part?.text && !part?.thought)
    .map((part) => part.text)
    .join("")
    .trim() || "";
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("cloud vision timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function describeImageWithGemini({ buffer, mimeType = "image/png", prompt, source }) {
  const client = nextClient();
  if (!client || !buffer?.length) return null;
  const model = config.local?.visionCloudFallbackModel || config.geminiFastModel;
  const timeoutMs = config.local?.visionCloudFallbackTimeoutMs || 20_000;
  const instruction = [
    prompt,
    "",
    "Higher-accuracy fallback pass: describe the actual visible image. If this is a phone screenshot, inspect the whole image and transcribe readable UI text. Do not say it failed to load unless the image data is genuinely unreadable.",
  ].join("\n");

  try {
    const response = await withTimeout(client.models.generateContent({
      model,
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType, data: Buffer.from(buffer).toString("base64") } },
          { text: instruction },
        ],
      }],
      config: {
        temperature: 0,
        topP: 0.25,
        maxOutputTokens: 1200,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }), timeoutMs);
    const text = extractText(response);
    if (text) {
      log(`[VisionFallback] Gemini vision used (${source || "fallback"}, model=${model})`);
      return text;
    }
  } catch (err) {
    log(`[VisionFallback] Gemini vision failed: ${err?.message || err}`);
  }
  return null;
}
