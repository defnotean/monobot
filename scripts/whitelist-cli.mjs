// Direct whitelist admin against Supabase. Bypasses the bot's owner gate so you
// can inspect or mutate `bot_data.server_whitelist` without going through Eris
// or Irene. Eris stores under id="main", Irene under id="irene".
//
// Usage (from repo root):
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/whitelist-cli.mjs list
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/whitelist-cli.mjs remove jett
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/whitelist-cli.mjs remove 1234567890
//
// Match rules for `remove`:
//   - if the arg is 17–20 digits, treat it as a guild ID (exact match)
//   - otherwise, case-insensitive substring match against the server name
//
// Falls back to packages/eris/.env or packages/irene/.env for SUPABASE creds
// if they're not in process.env.

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = line.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const envFiles = [
  loadEnvFile(join(repoRoot, "packages/eris/.env")),
  loadEnvFile(join(repoRoot, "packages/irene/.env")),
];
const env = (k) => process.env[k] || envFiles[0][k] || envFiles[1][k];

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_KEY = env("SUPABASE_KEY") || env("SUPABASE_ANON_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("missing SUPABASE_URL / SUPABASE_KEY — set them in env or in packages/eris/.env or packages/irene/.env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ROWS = [
  { id: "main",  label: "Eris  (bot_data.id=main)" },
  { id: "irene", label: "Irene (bot_data.id=irene)" },
];

async function loadRow(id) {
  const { data: row, error } = await supabase.from("bot_data").select("data").eq("id", id).single();
  if (error && error.code !== "PGRST116") throw error;
  return row?.data || {};
}

async function saveRow(id, data) {
  const { error } = await supabase.from("bot_data").upsert({ id, data });
  if (error) throw error;
}

function formatEntry(guildId, info) {
  const name = info?.name ?? "Unknown";
  const added = info?.added_at ? ` — added ${info.added_at}` : "";
  const members = info?.members != null ? ` — ~${info.members} members` : "";
  return `  ${guildId}  ${name}${members}${added}`;
}

function findMatches(whitelist, query) {
  const isId = /^\d{17,20}$/.test(query);
  if (isId) {
    return whitelist[query] ? [[query, whitelist[query]]] : [];
  }
  const q = query.toLowerCase();
  return Object.entries(whitelist).filter(([, info]) => (info?.name || "").toLowerCase().includes(q));
}

async function cmdList() {
  for (const { id, label } of ROWS) {
    const data = await loadRow(id);
    const wl = data.server_whitelist || {};
    const entries = Object.entries(wl);
    console.log(`\n${label} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
    if (!entries.length) continue;
    for (const [gid, info] of entries) console.log(formatEntry(gid, info));
  }
}

async function cmdRemove(query) {
  if (!query) {
    console.error("usage: remove <guild-id-or-name>");
    process.exit(1);
  }
  let totalRemoved = 0;
  for (const { id, label } of ROWS) {
    const data = await loadRow(id);
    const wl = data.server_whitelist || {};
    const matches = findMatches(wl, query);
    if (!matches.length) {
      console.log(`${label}: no match for "${query}"`);
      continue;
    }
    for (const [gid, info] of matches) {
      delete wl[gid];
      console.log(`${label}: removed ${gid} (${info?.name ?? "Unknown"})`);
      totalRemoved++;
    }
    data.server_whitelist = wl;
    await saveRow(id, data);
  }
  console.log(`\ndone — ${totalRemoved} entr${totalRemoved === 1 ? "y" : "ies"} removed across both rows`);
}

const [, , action, ...rest] = process.argv;
const query = rest.join(" ").trim();

try {
  if (action === "list") await cmdList();
  else if (action === "remove") await cmdRemove(query);
  else {
    console.error("usage:");
    console.error("  node scripts/whitelist-cli.mjs list");
    console.error("  node scripts/whitelist-cli.mjs remove <guild-id-or-name>");
    process.exit(1);
  }
} catch (e) {
  console.error("error:", e?.message || e);
  process.exit(1);
}
