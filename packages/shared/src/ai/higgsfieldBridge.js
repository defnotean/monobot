import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

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
    /** @type {NodeJS.Timeout | undefined} */
    let timeoutTimer;
    /** @type {NodeJS.Timeout | undefined} */
    let graceTimer;
    let settled = false;
    let stdout = "";
    let stderr = "";

    let proc;
    try {
      proc = spawn(command, [], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HIGGSFIELD_JOB: JSON.stringify(payload || {}),
        },
      });
    } catch (err) {
      // spawn can throw synchronously (ENOENT, bad stdio setup, EACCES).
      reject(err);
      return;
    }

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      fn(value);
    };

    const killProc = (graceMs = KILL_GRACE_MS) => {
      if (proc.pid == null || proc.killed) return;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      if (typeof proc.unref === "function") proc.unref();
      graceTimer = setTimeout(() => {
        // Take down the whole process group so any child processes spawned by
        // the wrapper don't keep running (GPU/CLI jobs) after we've given up.
        try { process.kill(-proc.pid, "SIGKILL"); } catch { /* no group */ }
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }, graceMs);
      if (typeof graceTimer.unref === "function") graceTimer.unref();
    };

    const overLimit = () => {
      if (settled) return;
      settle(
        reject,
        new Error(`Higgsfield command produced more than ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB of output — aborting job`),
      );
      killProc();
    };

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settle(reject, new Error(`Higgsfield command timed out after ${timeoutMs}ms`));
      killProc();
    }, timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

    proc.stdout?.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) overLimit();
    });
    proc.stderr?.on("data", (chunk) => {
      if (settled) return;
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) overLimit();
    });
    // A child that closes a pipe before we write (or after we kill it) must
    // never surface an unhandled 'error' event and crash the bot process.
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
    proc.stdin?.on("error", () => {});

    proc.on("error", (err) => {
      settle(reject, err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        settle(reject, new Error(`Higgsfield command exit ${code}: ${stderr.replace(/\s+/g, " ").slice(0, 300)}`));
        return;
      }
      const result = parseJsonOrText(stdout);
      if (stderr.trim() && !result.warning) result.warning = stderr.trim().slice(0, 300);
      settle(resolve, result);
    });

    // Send the job payload last, guarded against a child that already exited
    // (fast-exit wrappers close stdin immediately — EPIPE here is normal, not
    // a crash, thanks to the stdin error handler above).
    try {
      proc.stdin.end(JSON.stringify(payload || {}));
    } catch { /* stdin already closed — the child exited early */ }
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