// Llama Prompt Guard 2 local classifier integration.
//
// The previous tokenizer dependency pulled in vulnerable protobufjs through
// @xenova/transformers. Until a maintained local tokenizer is selected, this
// module cleanly reports unavailable and callers fall back to the legacy Voyage
// path. The public API stays stable so a safe tokenizer can be reintroduced
// without touching callers.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let _initPromise = null;
let _initFailed = false;

const DEFAULT_MODEL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "models", "promptguard2"
);

export async function initPromptGuard({ modelDir = DEFAULT_MODEL_DIR, log = () => {} } = {}) {
  if (_initFailed) return false;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const modelPath = join(modelDir, "model.onnx");
    if (!existsSync(modelPath)) {
      log(`[PROMPTGUARD] model.onnx not found at ${modelPath}; falling back to Voyage. Run scripts/download-prompt-guard.js to install.`);
      _initFailed = true;
      return false;
    }

    log("[PROMPTGUARD] local tokenizer support is disabled pending a safe maintained dependency; falling back to Voyage.");
    _initFailed = true;
    return false;
  })();

  return _initPromise;
}

export function isPromptGuardAvailable() {
  return false;
}

export async function classify(_text) {
  return null;
}

export function _resetForTests() {
  _initPromise = null;
  _initFailed = false;
}
