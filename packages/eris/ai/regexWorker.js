// ─── Persistent Regex Worker Thread ─────────────────────────────────────────
// Runs pattern matching in an isolated V8 thread.
// If a payload triggers catastrophic backtracking (ReDoS), the main thread
// times out and moves on — the worker finishes eventually without blocking anyone.

import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ id, patterns, text }) => {
  for (const src of patterns) {
    try {
      const match = src.match(/^\/(.+)\/([gimsuy]*)$/s);
      if (match) {
        const re = new RegExp(match[1], match[2]);
        if (re.test(text)) {
          parentPort.postMessage({ id, matched: true, pattern: match[1].substring(0, 60) });
          return;
        }
      }
    } catch {}
  }
  parentPort.postMessage({ id, matched: false });
});
