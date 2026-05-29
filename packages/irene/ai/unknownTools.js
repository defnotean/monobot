// @ts-check

export const UNKNOWN_TOOL_TTL_MS = 60 * 60_000;
export const UNKNOWN_TOOL_MAX_KEYS = 512;

// Exported for tests and runtime introspection. Values intentionally remain
// numbers so existing call sites can read `_unknownToolCounts.get(name)`.
export const _unknownToolCounts = new Map();
const _unknownToolLastSeen = new Map();

/**
 * @param {{ now?: number } | undefined} opts
 */
function nowMs(opts) {
  return typeof opts?.now === "number" ? opts.now : Date.now();
}

function oldestUnknownToolName() {
  let oldestName = null;
  let oldestSeen = Infinity;
  for (const [name, seen] of _unknownToolLastSeen) {
    if (seen < oldestSeen) {
      oldestSeen = seen;
      oldestName = name;
    }
  }
  return oldestName;
}

/**
 * Drop stale unknown-tool counters and cap key cardinality. This prevents a
 * long-running bot from accumulating one Map entry for every hallucinated tool
 * spelling it has ever seen.
 *
 * @param {{ now?: number, ttlMs?: number, maxKeys?: number }} [opts]
 * @returns {number} number of entries removed
 */
export function pruneUnknownToolCounts(opts = {}) {
  const now = nowMs(opts);
  const ttlMs = opts.ttlMs ?? UNKNOWN_TOOL_TTL_MS;
  const maxKeys = opts.maxKeys ?? UNKNOWN_TOOL_MAX_KEYS;
  let removed = 0;

  for (const [name, lastSeen] of _unknownToolLastSeen) {
    if (now - lastSeen > ttlMs) {
      _unknownToolLastSeen.delete(name);
      if (_unknownToolCounts.delete(name)) removed++;
    }
  }

  while (_unknownToolCounts.size > maxKeys) {
    const oldest = oldestUnknownToolName();
    if (!oldest) break;
    _unknownToolLastSeen.delete(oldest);
    if (_unknownToolCounts.delete(oldest)) removed++;
  }

  return removed;
}

/**
 * Increment the counter for an unknown tool name, pruning stale/extra entries.
 *
 * @param {string} toolName
 * @param {{ now?: number, ttlMs?: number, maxKeys?: number }} [opts]
 * @returns {number} updated count
 */
export function recordUnknownTool(toolName, opts = {}) {
  const now = nowMs(opts);
  const name = String(toolName || "unknown");
  pruneUnknownToolCounts({ ...opts, now });
  const count = (_unknownToolCounts.get(name) || 0) + 1;
  _unknownToolCounts.set(name, count);
  _unknownToolLastSeen.set(name, now);
  pruneUnknownToolCounts({ ...opts, now });
  return count;
}

export function clearUnknownToolCounts() {
  _unknownToolCounts.clear();
  _unknownToolLastSeen.clear();
}
