const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

function sleep(ms, setTimer) {
  return new Promise((resolve) => setTimer(resolve, ms));
}

/**
 * @param {{ login: (token: string) => Promise<unknown> }} client
 * @param {string} token
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {(callback: () => void, ms?: number) => any} [options.setTimer]
 */
export async function loginDiscordWithRetry(client, token, {
  log = () => {},
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  setTimer = setTimeout,
} = {}) {
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await client.login(token);
    } catch (err) {
      attempt++;
      const waitMs = Math.min(maxDelayMs, baseDelayMs * attempt);
      log(`[SYS] Discord login attempt ${attempt} failed: ${err?.message ?? err} - retrying in ${waitMs / 1000}s (HTTP server stays up)`);
      await sleep(waitMs, setTimer);
    }
  }
}
