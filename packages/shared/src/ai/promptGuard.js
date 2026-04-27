// ─── Llama Prompt Guard 2 (22M, ONNX) — local L3 classifier ───────────────
// Phase 3.15: replaces the Voyage embedding + pgvector similarity loop with a
// single in-process forward pass. mDeBERTa-xsmall, 22M params, 2.5MB ONNX file.
// CPU latency target: 15-40ms per check on a modern server core.
//
// Required at runtime (lazy-loaded so the bot boots even if missing):
//   - npm pkg: onnxruntime-node (added to packages/shared/package.json)
//   - npm pkg: @xenova/transformers (for the mDeBERTa tokenizer)
//   - model file: <BOT_ROOT>/models/promptguard2/model.onnx
//   - tokenizer: <BOT_ROOT>/models/promptguard2/ (tokenizer.json + config.json)
// Download instructions: scripts/download-prompt-guard.js
//
// Reference: https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M
//            https://huggingface.co/shisa-ai/promptguard2-onnx (ONNX export)

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let _session = null;
let _tokenizer = null;
let _initPromise = null;
let _initFailed = false;

const DEFAULT_MODEL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "models", "promptguard2"
);

/**
 * Initialize the Prompt Guard 2 model. Idempotent. Returns true on success.
 * If the model isn't installed, returns false and sets _initFailed; the caller
 * should fall back to the legacy Voyage path.
 */
export async function initPromptGuard({ modelDir = DEFAULT_MODEL_DIR, log = () => {} } = {}) {
  if (_session) return true;
  if (_initFailed) return false;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const modelPath = join(modelDir, "model.onnx");
    if (!existsSync(modelPath)) {
      log(`[PROMPTGUARD] model.onnx not found at ${modelPath} — falling back to Voyage. Run scripts/download-prompt-guard.js to install.`);
      _initFailed = true;
      return false;
    }

    let ort, transformers;
    try {
      ort = await import("onnxruntime-node");
    } catch (e) {
      log(`[PROMPTGUARD] onnxruntime-node not installed — falling back to Voyage. (${e?.message ?? e})`);
      _initFailed = true;
      return false;
    }
    try {
      transformers = await import("@xenova/transformers");
    } catch (e) {
      log(`[PROMPTGUARD] @xenova/transformers not installed — falling back to Voyage. (${e?.message ?? e})`);
      _initFailed = true;
      return false;
    }

    try {
      _session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: 2,
      });
      // Tokenizer auto-locates tokenizer.json + config.json in the same dir.
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      transformers.env.localModelPath = resolve(modelDir, "..");
      _tokenizer = await transformers.AutoTokenizer.from_pretrained("promptguard2");
      log(`[PROMPTGUARD] initialized (model.onnx loaded from ${modelPath})`);
      return true;
    } catch (e) {
      log(`[PROMPTGUARD] init failed: ${e?.message ?? e} — falling back to Voyage`);
      _initFailed = true;
      _session = null;
      _tokenizer = null;
      return false;
    }
  })();

  return _initPromise;
}

export function isPromptGuardAvailable() {
  return _session != null && _tokenizer != null;
}

/**
 * Classify text. Returns { score, label } where score is the model's
 * "INJECTION" probability in [0,1] and label is "BENIGN" | "INJECTION".
 * Returns null if the model isn't initialized.
 */
export async function classify(text) {
  if (!_session || !_tokenizer) return null;
  const ort = await import("onnxruntime-node");
  const truncated = text.length > 2000 ? text.substring(0, 2000) : text;
  const enc = await _tokenizer(truncated, { padding: true, truncation: true, max_length: 512, return_tensors: "np" });

  const ids = BigInt64Array.from((enc.input_ids?.data ?? enc.input_ids).map(x => BigInt(x)));
  const mask = BigInt64Array.from((enc.attention_mask?.data ?? enc.attention_mask).map(x => BigInt(x)));
  const seqLen = ids.length;

  const inputIds = new ort.Tensor("int64", ids, [1, seqLen]);
  const attnMask = new ort.Tensor("int64", mask, [1, seqLen]);

  const feeds = { input_ids: inputIds, attention_mask: attnMask };
  const out = await _session.run(feeds);
  const logitsTensor = out.logits ?? out[Object.keys(out)[0]];
  const logits = Array.from(logitsTensor.data);

  // Two-class softmax (BENIGN, INJECTION) — model is fine-tuned this way.
  const maxL = Math.max(logits[0], logits[1]);
  const e0 = Math.exp(logits[0] - maxL);
  const e1 = Math.exp(logits[1] - maxL);
  const sum = e0 + e1;
  const injection = e1 / sum;
  return { score: injection, label: injection > 0.5 ? "INJECTION" : "BENIGN" };
}

/**
 * Test hook only — resets module state so unit tests can re-init from scratch.
 * Not part of the public API.
 */
export function _resetForTests() {
  _session = null;
  _tokenizer = null;
  _initPromise = null;
  _initFailed = false;
}
