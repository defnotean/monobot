import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * @typedef {{ command?: string, payload?: Record<string, any>, timeoutMs?: number, cwd?: string }} HiggsfieldCommandOptions
 */

/** @param {string} text */
function parseJsonOrText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: true };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { ok: true, message: trimmed };
  }
}

/** @param {HiggsfieldCommandOptions} [options] @returns {Promise<any>} */
export async function runHiggsfieldCommand({
  command,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
} = {}) {
  if (!command) {
    throw new Error("HIGGSFIELD_COMMAND is not configured. Point it at a local authenticated Higgsfield CLI/MCP wrapper.");
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HIGGSFIELD_JOB: JSON.stringify(payload || {}),
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Higgsfield command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Higgsfield command exit ${code}: ${stderr.replace(/\s+/g, " ").slice(0, 300)}`));
        return;
      }
      const result = parseJsonOrText(stdout);
      if (stderr.trim() && !result.warning) result.warning = stderr.trim().slice(0, 300);
      resolve(result);
    });
    proc.stdin.end(JSON.stringify(payload || {}));
  });
}

/** @param {string} action @param {Record<string, any>} [input] */
export function buildHiggsfieldPayload(action, input = {}) {
  return {
    action,
    prompt: input.prompt || input.description || "",
    image_url: input.image_url || input.reference_image_url || null,
    video_url: input.video_url || input.source_url || null,
    product_url: input.product_url || null,
    youtube_url: input.youtube_url || null,
    character_name: input.character_name || input.name || null,
    reference_urls: Array.isArray(input.reference_urls) ? input.reference_urls : [],
    aspect_ratio: input.aspect_ratio || input.aspectRatio || "9:16",
    duration_seconds: input.duration_seconds || input.durationSeconds || null,
    style: input.style || null,
    count: input.count || null,
    extra: input.extra || {},
  };
}
