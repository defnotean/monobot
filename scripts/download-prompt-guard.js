#!/usr/bin/env node
// Download Llama Prompt Guard 2 22M ONNX from Hugging Face into models/promptguard2/.
// No auth required — shisa-ai's ONNX export is published openly.
//
// Usage: npm run download:prompt-guard
//        OR: node scripts/download-prompt-guard.js
//
// Total download: ~3MB (model.onnx is the bulk; the ONNX export is 2.5MB,
// tokenizer.json + config.json are tiny).

import { mkdir, stat } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO = "shisa-ai/promptguard2-onnx";
// Files in this repo are nested under `payload/`. We download them and flatten
// into <modelDir>/ so the runtime doesn't care about the upstream layout.
const FILES = [
  "payload/model.onnx",
  "payload/model.onnx.data",
  "payload/tokenizer.json",
  "payload/tokenizer_config.json",
  "payload/config.json",
  "payload/special_tokens_map.json",
];
const REQUIRED = new Set(["payload/model.onnx", "payload/tokenizer.json", "payload/config.json"]);
const TARGET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "models", "promptguard2");

async function downloadOne(file) {
  const url = `https://huggingface.co/${REPO}/resolve/main/${file}?download=true`;
  // Flatten payload/x → x in the local target dir.
  const flatName = file.startsWith("payload/") ? file.slice("payload/".length) : file;
  const out = resolve(TARGET_DIR, flatName);

  if (existsSync(out)) {
    const s = await stat(out);
    if (s.size > 0) {
      console.log(`✓ ${flatName} (${(s.size / 1024).toFixed(1)} KB) — already present, skipping`);
      return;
    }
  }

  console.log(`↓ ${flatName} from ${REPO}…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    if (res.status === 404 && !REQUIRED.has(file)) {
      console.log(`  (optional file ${flatName} not present in repo — skipping)`);
      return;
    }
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  const finalSize = (await stat(out)).size;
  console.log(`  → ${out} (${(finalSize / 1024).toFixed(1)} KB${total ? ` of ${(total / 1024).toFixed(1)} KB` : ""})`);
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });
  console.log(`Downloading Prompt Guard 2 ONNX model into ${TARGET_DIR}\n`);
  let requiredFailed = false;
  for (const f of FILES) {
    try { await downloadOne(f); }
    catch (e) {
      console.error(`✗ ${f}: ${e.message}`);
      if (REQUIRED.has(f)) requiredFailed = true;
    }
  }
  if (requiredFailed) {
    // Soft-fail: do NOT exit non-zero. The bot's promptGuard.js detects the
    // missing model file and falls back to the Voyage L3 path, which keeps the
    // service running even when this script can't reach Hugging Face. Failing
    // the build hard would be worse than running with Voyage as L3.
    console.error("\n⚠ One or more required files failed to download. The bot will fall back to Voyage for L3.");
    process.exit(0);
  }
  console.log("\n✓ Done. Eris and Irene will detect the model on next start.");
  console.log("  (If they don't, ensure onnxruntime-node and @xenova/transformers are installed: `npm install` from the repo root.)");
}

main().catch(e => { console.error(e); process.exit(1); });
