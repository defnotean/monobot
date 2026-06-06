const DEFAULT_HANDSHAKE_ERROR_LIMIT = 6;
const DEFAULT_EXIT_DELAY_MS = 500;
const HANDSHAKE_TIMEOUT_RE = /\bopening handshake has timed out\b/i;

export function isGatewayHandshakeTimeout(err) {
  return HANDSHAKE_TIMEOUT_RE.test(String(err?.message ?? err ?? ""));
}

/**
 * @typedef {object} GatewayWatchdogOptions
 * @property {number} [errorLimit]
 * @property {number} [exitDelayMs]
 * @property {(message: string) => void} [log]
 * @property {(((kind: string, message?: string, opts?: any) => Promise<unknown> | unknown) | null)} [sendAlert]
 * @property {(code: number) => void} [exit]
 * @property {(callback: () => void, ms?: number) => any} [setTimer]
 * @property {(timer: any) => void} [clearTimer]
 */

/**
 * @param {GatewayWatchdogOptions} [options]
 */
export function createGatewayWatchdog({
  errorLimit = DEFAULT_HANDSHAKE_ERROR_LIMIT,
  exitDelayMs = DEFAULT_EXIT_DELAY_MS,
  log = () => {},
  sendAlert = null,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const limit = Number.isFinite(Number(errorLimit)) && Number(errorLimit) > 0
    ? Number(errorLimit)
    : DEFAULT_HANDSHAKE_ERROR_LIMIT;

  let consecutiveHandshakeErrors = 0;
  let exiting = false;
  let exitTimer = null;

  function reset() {
    consecutiveHandshakeErrors = 0;
  }

  function stop() {
    if (exitTimer) clearTimer(exitTimer);
    exitTimer = null;
    exiting = false;
    reset();
  }

  function scheduleExit(shardId) {
    if (exiting) return;
    exiting = true;

    const detail = `Shard ${shardId} hit ${consecutiveHandshakeErrors} consecutive Discord gateway opening-handshake timeouts`;
    log(`[GatewayWatchdog] ${detail}; exiting for supervisor restart`);

    if (typeof sendAlert === "function") {
      try {
        void Promise.resolve(sendAlert(
          "gateway-handshake-timeout",
          `${detail}. Restarting Irene to clear the gateway session.`,
          { bot: "IRENE", log },
        )).catch(() => {});
      } catch {}
    }

    exitTimer = setTimer(() => exit(1), exitDelayMs);
    if (typeof exitTimer?.unref === "function") exitTimer.unref();
  }

  function recordShardError(err, shardId = 0) {
    if (!isGatewayHandshakeTimeout(err)) return false;

    consecutiveHandshakeErrors++;
    if (consecutiveHandshakeErrors >= limit) scheduleExit(shardId);
    return true;
  }

  return {
    recordShardError,
    reset,
    stop,
    getConsecutiveHandshakeErrors: () => consecutiveHandshakeErrors,
    get exiting() { return exiting; },
  };
}
