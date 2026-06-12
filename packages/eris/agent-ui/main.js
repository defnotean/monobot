const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

// ─── ENV ─────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
const configPath = path.join(__dirname, 'config.json');

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
    const c = { ...loadConfig(), ...data };
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
}
function getEnv(key) {
    const c = loadConfig();
    if (c[key]) return c[key];
    // Fall back to .env file
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const idx = t.indexOf('=');
            if (idx === -1) continue;
            if (t.slice(0, idx).trim() === key) return t.slice(idx + 1).trim();
        }
    } catch {}
    return process.env[key] || '';
}

// Load .env into process.env once at startup
try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const idx = t.indexOf('=');
        if (idx === -1) continue;
        const k = t.slice(0, idx).trim();
        const v = t.slice(idx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
    }
} catch {}

// ─── DESTRUCTIVE-COMMAND GATE ──────────────────────────────────────────────────
// HOST-SIDE copy of the bot's looksDestructive detector. SOURCE OF TRUTH lives
// in packages/eris/utils/pcAgent.js (~lines 40-134) — keep the two in sync. The
// agent-ui is a separate CommonJS app that can't cleanly import the bot's ESM
// modules, so the logic is duplicated here. This runs on every drained
// local_commands row and every run-terminal IPC so a poisoned queue / renderer
// can't wipe the host: the enqueuer is NOT trusted.
const WS = "[\\s\\u00A0\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]";
const DESTRUCTIVE_PATTERNS = [
    new RegExp(`\\brm${WS}+(-[a-z]*[rfRF][a-z]*${WS}+)?[\\/~]`, "iu"),
    new RegExp(`\\brm${WS}+-[a-z]*[rfRF]`, "iu"),
    new RegExp(`\\b(del|erase)${WS}+\\/[sfq]`, "iu"),
    new RegExp(`\\b(rmdir|rd)${WS}+\\/s`, "iu"),
    new RegExp(`\\brd${WS}+(-[a-z]*[rfRF][a-z]*${WS}+)?[\\/~]`, "iu"),
    new RegExp(`\\bformat${WS}+[a-z]:`, "iu"),
    /\bdiskpart\b/iu,
    new RegExp(`\\bmkfs(\\.|${WS})`, "iu"),
    new RegExp(`\\bdd${WS}+[^|]*\\bof=\\/dev\\/`, "iu"),
    /\b:(?:\(\s*\)\s*\{\s*:\|:&\s*\}\s*;\s*:|\s*\(\)\s*\{\s*:\|:)/iu,
    new RegExp(`\\breg${WS}+delete\\b`, "iu"),
    new RegExp(`\\bsc${WS}+delete\\b`, "iu"),
    /\bshutdown\b/iu,
    new RegExp(`\\bnet${WS}+user\\b.*\\/(add|delete)`, "iu"),
    new RegExp(`\\btakeown${WS}+\\/f`, "iu"),
    /\bicacls\b.*\/deny/iu,
    new RegExp(`\\b(?:Remove-Item|ri|rd|rm|del|erase|rmdir)\\b(?=[^|]*${WS}-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?\\b)(?=[^|]*${WS}-f(?:o(?:r(?:ce?)?)?)?\\b)`, "iu"),
    /\bStop-Computer\b/iu,
    /\bRestart-Computer\b/iu,
    /\bClear-EventLog\b/iu,
    /(?:^|[^-=>])>{1,2}(?!&)/u,
    /\b(?:Set-Content|Add-Content|Out-File|Tee-Object)\b/iu,
    /\[(?:System\.)?IO\.File\]\s*::\s*Write/iu,
    new RegExp(`\\bpowershell(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bpwsh(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bcmd(\\.exe)?\\b[^|]*${WS}\\/c\\b`, "iu"),
];
const HARD_BLOCK_PATTERNS = [
    new RegExp(`\\bpowershell(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bpwsh(\\.exe)?\\b[^|]*${WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bcmd(\\.exe)?\\b[^|]*${WS}\\/c\\b`, "iu"),
    new RegExp(`\\b(?:bash|sh|zsh|fish)${WS}+-c\\b`, "iu"),
    /\b(?:Invoke-Expression|iex)\b/iu,
    /\bStart-Process\b[^|]*(?:^|\s)-Verb\s+RunAs\b/iu,
    /\bSet-ExecutionPolicy\b/iu,
    new RegExp(`\\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\\b[^|]*(?:\\||;|&&)${WS}*(?:sh|bash|pwsh|powershell|iex|Invoke-Expression)\\b`, "iu"),
];
const CHAIN_SPLIT = /(?:&&|\|\||;|\||&|`|\$\(|>{1,2})/u;

function normalizeForMatch(command) {
    if (typeof command !== 'string') return '';
    let s;
    try { s = command.normalize('NFKC'); } catch { s = command; }
    s = s.replace(/[​-‍⁠﻿­]/g, '');
    return s;
}
function matchDestructive(normalized) {
    for (const pat of DESTRUCTIVE_PATTERNS) {
        if (pat.test(normalized)) return pat.source;
    }
    return null;
}
function matchHardBlocked(normalized) {
    for (const pat of HARD_BLOCK_PATTERNS) {
        if (pat.test(normalized)) return pat.source;
    }
    return null;
}
// Returns the matched pattern source if the command looks destructive, else null.
function looksDestructive(command) {
    if (!command || typeof command !== 'string') return null;
    const normalized = normalizeForMatch(command);
    if (!normalized) return null;
    const whole = matchDestructive(normalized);
    if (whole) return whole;
    if (CHAIN_SPLIT.test(normalized)) {
        for (const part of normalized.split(CHAIN_SPLIT)) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const hit = matchDestructive(trimmed);
            if (hit) return hit;
        }
    }
    return null;
}
// Returns the matched pattern source if the command uses an opaque/elevated
// shell form that is never allowed, even with renderer/user confirmation.
function looksHardBlocked(command) {
    if (!command || typeof command !== 'string') return null;
    const normalized = normalizeForMatch(command);
    if (!normalized) return null;
    const whole = matchHardBlocked(normalized);
    if (whole) return whole;
    if (CHAIN_SPLIT.test(normalized)) {
        for (const part of normalized.split(CHAIN_SPLIT)) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const hit = matchHardBlocked(trimmed);
            if (hit) return hit;
        }
    }
    return null;
}

function gateShellCommand(command, { confirm } = {}) {
    const hardBlocked = looksHardBlocked(command);
    if (hardBlocked) {
        return {
            ok: false,
            reason: `refusing - this shell form is not allowed even with confirm (matched /${hardBlocked}/). use a direct, reviewable command instead.`
        };
    }
    const destructive = looksDestructive(command);
    if (destructive && !confirm) {
        return {
            ok: false,
            reason: `refusing - destructive command (matched /${destructive}/); set confirm: true to override`
        };
    }
    return { ok: true };
}

// ─── FILESYSTEM CONTAINMENT ────────────────────────────────────────────────────
// The renderer must never get arbitrary-path filesystem access through the
// read-dir/read-file/write-file IPC: containment is enforced HERE in main, not
// in the renderer. Only roots that main itself handed to the renderer (the
// folder picked in the open-folder dialog, clone destinations under
// ~/EvilIreneRepos) are readable/writable, and writes to persistence/secret
// targets are denied outright even inside an allowed root.
const allowedFsRoots = new Set();

function addAllowedFsRoot(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath) return;
    try { allowedFsRoots.add(path.resolve(rootPath)); } catch {}
}

// Resolve a renderer-supplied path and require it to live inside one of the
// allowlisted roots (case-insensitive on win32). Returns the resolved absolute
// path, or null when the path escapes every root — path.resolve collapses `..`
// segments, so the prefix check covers both absolute escapes and traversal.
function resolveInAllowedRoot(targetPath, roots = allowedFsRoots) {
    if (typeof targetPath !== 'string' || !targetPath) return null;
    let resolved;
    try { resolved = path.resolve(targetPath); } catch { return null; }
    const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const candidate = fold(resolved);
    for (const root of roots) {
        const base = fold(root);
        if (candidate === base || candidate.startsWith(base + path.sep)) return resolved;
    }
    return null;
}

// Hard-deny writes to persistence / secret / hook targets regardless of root:
// Startup folders (run-at-logon persistence), .env secret files, SSH keys and
// config, and git hooks (code execution on the next git command).
const SENSITIVE_WRITE_PATTERNS = [
    /[\\/]start menu[\\/]programs[\\/]startup([\\/]|$)/i,
    /(^|[\\/])[^\\/]*\.env(\.[^\\/]*)?$/i,
    /(^|[\\/])\.ssh([\\/]|$)/i,
    /[\\/]\.git[\\/]hooks([\\/]|$)/i,
];
function isSensitiveWritePath(resolvedPath) {
    if (typeof resolvedPath !== 'string' || !resolvedPath) return false;
    return SENSITIVE_WRITE_PATTERNS.some(re => re.test(resolvedPath));
}

// Validate a renderer-supplied clone request: https + github.com only (URL
// parse, not regex), no embedded credentials, and a repo name that cannot
// traverse out of the clone root. Combined with execFile (argv, no cmd.exe
// string) this closes the quote-breakout injection in the old exec() form.
function validateCloneRequest(cloneUrl, repoName) {
    let u;
    try { u = new URL(String(cloneUrl)); } catch { return { ok: false, error: 'invalid clone URL' }; }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') {
        return { ok: false, error: 'only https://github.com clone URLs are allowed' };
    }
    if (u.username || u.password) {
        return { ok: false, error: 'credentials in clone URLs are not allowed' };
    }
    const name = String(repoName || '');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        return { ok: false, error: 'invalid repo name' };
    }
    return { ok: true };
}

// open-external allowlist: parse the URL in MAIN (the renderer is untrusted)
// and allow only http/https/mailto — no file:, no app/custom protocols.
function isAllowedExternalUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
}

// ─── LOCAL-COMMAND AUTHENTICATION ──────────────────────────────────────────────
// local_commands is an UNAUTHENTICATED host-command channel: anyone who can
// insert a row gets shell on the owner's box. Before exec, the poller must
// independently verify the row was enqueued by the owner and signed with the
// shared secret — never trust requested_by alone. The bot signs on enqueue with
//   sig = HMAC_SHA256(TWIN_API_SECRET, `${requested_by}.${command}.${ts}`)
// (hex), so we recompute and timingSafeEqual-compare here. Fails CLOSED: a
// missing secret, missing sig/ts (pre-migration rows), wrong owner, bad sig, or
// stale ts all reject with a logged reason. Pure function so it is unit-testable
// in isolation without Electron/Supabase.
const LOCAL_CMD_MAX_AGE_MS = 5 * 60 * 1000; // reject rows older than 5 minutes

function verifyLocalCommand(row, { ownerId, secret, now = Date.now() } = {}) {
    if (!secret) return { ok: false, reason: 'no TWIN_API_SECRET configured on host — cannot verify command signature' };
    if (!ownerId) return { ok: false, reason: 'no BOT_OWNER_ID configured on host — cannot verify command origin' };
    if (!row || typeof row !== 'object') return { ok: false, reason: 'invalid command row' };
    if (String(row.requested_by || '') !== String(ownerId)) {
        return { ok: false, reason: `requested_by (${row.requested_by}) is not the owner` };
    }
    if (row.sig == null || row.ts == null) {
        return { ok: false, reason: 'missing sig/ts columns (pre-migration row?) — rejecting fail-closed' };
    }
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'non-numeric ts' };
    if (Math.abs(now - ts) > LOCAL_CMD_MAX_AGE_MS) {
        return { ok: false, reason: `stale ts (age ${Math.round((now - ts) / 1000)}s exceeds ${LOCAL_CMD_MAX_AGE_MS / 1000}s)` };
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(`${row.requested_by}.${row.command}.${row.ts}`)
        .digest('hex');
    const provided = String(row.sig);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, reason: 'bad signature' };
    }
    return { ok: true };
}

// Exported for unit tests (required from a non-Electron context). Under Electron
// these are also used directly within this module.
module.exports = {
    looksDestructive, looksHardBlocked, gateShellCommand, verifyLocalCommand, normalizeForMatch,
    resolveInAllowedRoot, isSensitiveWritePath, validateCloneRequest, isAllowedExternalUrl,
};

// ─── ELECTRON ────────────────────────────────────────────────────────────────
// Guarded require: when this file is loaded outside Electron (e.g. a vitest
// unit test of the pure guard/verify functions above), `require('electron')`
// throws. We swallow that so the module still loads and exports its helpers;
// the app bootstrap below is skipped when `app` is unavailable.
let electron = null;
try { electron = require('electron'); } catch {}
const app = electron && electron.app;
const BrowserWindow = electron && electron.BrowserWindow;
const ipcMain = electron && electron.ipcMain;
const dialog = electron && electron.dialog;
const shell = electron && electron.shell;
const session = electron && electron.session;

const { createClient } = require('@supabase/supabase-js');

// ─── STATE ────────────────────────────────────────────────────────────────────
let mainWindow;
let supabase = null;
let pollInterval = null;
let commandsExecuted = 0;
let isConnected = false;

// ─── WINDOW ───────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 860, minWidth: 1000, minHeight: 640,
        frame: false, transparent: false, backgroundColor: '#0d0e10',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // The preload only touches contextBridge/ipcRenderer, so the
            // renderer can run fully sandboxed.
            sandbox: true,
            webSecurity: true
        },
        title: 'Eris IDE'
    });
    // The app is a single local file: any renderer-initiated navigation away
    // from it is hostile, and so is any new window.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== mainWindow.webContents.getURL()) event.preventDefault();
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.loadFile('index.html');
}

// ─── GITHUB API ───────────────────────────────────────────────────────────────
function githubRequest(endpoint, token, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = https.request({
            hostname: 'api.github.com',
            path: endpoint,
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'EvilIreneIDE/1.0',
                'Accept': 'application/vnd.github+json',
                ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {})
            }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
                catch { resolve({ status: res.statusCode, body: { message: data } }); }
            });
        });
        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

// ─── DISCORD REST ─────────────────────────────────────────────────────────────
function sendToDiscord(channelId, content) {
    return new Promise(resolve => {
        const token = getEnv('DISCORD_TOKEN');
        if (!token) return resolve();
        const body = Buffer.from(JSON.stringify({ content }));
        const req = https.request({
            hostname: 'discord.com',
            path: `/api/v10/channels/${channelId}/messages`,
            method: 'POST',
            headers: {
                'Authorization': `Bot ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': body.length
            }
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', () => resolve());
        req.write(body); req.end();
    });
}

// ─── AGENT POLL ───────────────────────────────────────────────────────────────
// Re-evaluate the kill switch on every invocation so a flipped env var halts
// drain immediately, even if rows are already in the queue. Reads from
// process.env *and* the local config (parity with getEnv()) so the env file
// can flip it without an Electron restart.
function isPcAgentDisabled() {
    const fromEnv = process.env.PC_AGENT_DISABLED;
    if (fromEnv === '1' || fromEnv === 'true') return true;
    try {
        const fromConfig = getEnv('PC_AGENT_DISABLED');
        if (fromConfig === '1' || fromConfig === 'true') return true;
    } catch {}
    return false;
}

async function pollCommands() {
    if (!supabase || !isConnected) return;
    // Kill-switch parity with the bot: refuse to drain when disabled.
    if (isPcAgentDisabled()) {
        mainWindow?.webContents.send('agent-log', 'Poll skipped: PC_AGENT_DISABLED=1');
        return;
    }
    try {
        const ownerId = getEnv('BOT_OWNER_ID');
        const secret = getEnv('TWIN_API_SECRET');
        const { data: commands, error } = await supabase
            .from('local_commands').select('*').eq('status', 'pending')
            .order('created_at', { ascending: true }).limit(5);
        if (error || !commands?.length) return;
        for (const cmd of commands) {
            // Re-check before each exec — a flip mid-batch must halt the rest
            // of the drain without leaving rows in the 'running' state.
            if (isPcAgentDisabled()) {
                mainWindow?.webContents.send('agent-log', `Skipped command ${cmd.id}: PC_AGENT_DISABLED=1`);
                break;
            }
            // local_commands is unauthenticated at the DB layer — independently
            // verify owner + HMAC sig before this row gets a shell. Fail closed.
            const auth = verifyLocalCommand(cmd, { ownerId, secret });
            if (!auth.ok) {
                mainWindow?.webContents.send('agent-log', `Rejected command ${cmd.id}: ${auth.reason}`);
                await supabase.from('local_commands').update({ status: 'error', result: `rejected: ${auth.reason}` }).eq('id', cmd.id);
                continue;
            }
            // Enforce the bot-side command policy host-side. Hard-blocked shell
            // forms are never confirmable because the command is not reviewable.
            const gate = gateShellCommand(cmd.command, { confirm: cmd.confirm });
            if (!gate.ok) {
                mainWindow?.webContents.send('agent-log', `Blocked command ${cmd.id}: ${gate.reason}`);
                await supabase.from('local_commands').update({ status: 'error', result: gate.reason }).eq('id', cmd.id);
                continue;
            }
            await supabase.from('local_commands').update({ status: 'running' }).eq('id', cmd.id);
            mainWindow?.webContents.send('agent-command-start', { command: cmd.command, id: cmd.id });
            exec(cmd.command, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash', timeout: 30000 }, async (err, stdout, stderr) => {
                let output = (stdout || stderr || (err ? err.message : 'No output.')).trim();
                if (output.length > 1800) output = output.substring(0, 1800) + '\n...(truncated)';
                commandsExecuted++;
                await supabase.from('local_commands').update({ status: 'done', result: output }).eq('id', cmd.id);
                if (cmd.channel_id) await sendToDiscord(cmd.channel_id, `\`\`\`powershell\n> ${cmd.command}\n\`\`\`\n\`\`\`\n${output}\n\`\`\``);
                mainWindow?.webContents.send('agent-command-done', { command: cmd.command, output, count: commandsExecuted, id: cmd.id });
            });
        }
    } catch (err) {
        mainWindow?.webContents.send('agent-log', `Poll error: ${err.message}`);
    }
}

let geminiKeyIndex = 0;
// ─── GEMINI ───────────────────────────────────────────────────────────────────
async function callGemini(message, history = [], systemOverride = null, useSearch = false) {
    const { GoogleGenAI } = require('@google/genai');
    const apiKeyString = getEnv('GEMINI_API_KEY');
    if (!apiKeyString) throw new Error('No GEMINI_API_KEY. Add it in Settings → save your key there. You can use comma separated keys.');
    
    const apiKeys = apiKeyString.split(',').map(k => k.trim()).filter(Boolean);
    if (!apiKeys.length) throw new Error('Invalid GEMINI_API_KEY format.');
    
    // Round-robin selection
    const apiKey = apiKeys[geminiKeyIndex % apiKeys.length];
    geminiKeyIndex++;

    const ai = new GoogleGenAI({ apiKey });

    let systemInstruction = systemOverride || `You are Eris, chaotically smart, snarky, and genuinely helpful. You have full access to the user's PC and can code, research, run commands, clone repos, and anything else. Keep responses concise and useful.`;
    if (!systemOverride && supabase) {
        try {
            const { data } = await supabase.from('eris_personality').select('instructions').eq('id', 'main').single();
            if (data?.instructions) systemInstruction = data.instructions;
        } catch {}
    }

    const contents = [
        ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: message }] }
    ];

    const config = { systemInstruction };
    // Enable Google Search grounding for research agents
    if (useSearch) {
        config.tools = [{ googleSearch: {} }];
    }

    const response = await ai.models.generateContent({
        model: 'gemma-4-26b-a4b-it',
        contents,
        config
    });
    return response.text || '...';
}

// ─── APP READY ────────────────────────────────────────────────────────────────
// Guarded: only bootstrap the Electron app when Electron actually loaded. Under
// vitest (no Electron) `app` is null and we skip straight past, leaving only the
// exported pure helpers reachable.
if (app) app.whenReady().then(() => {
    // CSP for everything served in the default session (mirrored by the
    // <meta http-equiv> tag in index.html in case file:// responses skip
    // webRequest). The renderer makes NO direct network calls — GitHub API,
    // Supabase, Gemini, and Discord all run in the main process — so
    // connect-src is fully closed; images allow the GitHub avatar host used
    // by the sidebar, styles/fonts allow the Google Fonts import in styles.css.
    const CSP = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' data: https://avatars.githubusercontent.com",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'none'",
    ].join('; ');
    if (session?.defaultSession) {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
        });
    }
    createWindow();

    // ── Agent ──────────────────────────────────────────────────────────────────
    ipcMain.handle('connect-agent', async () => {
        try {
            const url = getEnv('SUPABASE_URL');
            const key = getEnv('SUPABASE_KEY');
            if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_KEY. Add them in Settings.');
            supabase = createClient(url, key);
            const { error } = await supabase.from('local_commands').select('id').limit(1);
            if (error) throw error;
            isConnected = true;
            commandsExecuted = 0;
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(pollCommands, 2000);
            return { ok: true };
        } catch (err) {
            isConnected = false;
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('disconnect-agent', async () => {
        isConnected = false;
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        supabase = null;
        commandsExecuted = 0;
        return { ok: true };
    });

    // ── Chat + Sub-agents ─────────────────────────────────────────────────────
    ipcMain.handle('chat-irene', async (_, { message, history }) => {
        try {
            const reply = await callGemini(message, history);
            return { ok: true, reply };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Spawn a sub-agent with its own isolated context and system prompt
    ipcMain.handle('spawn-subagent', async (_, { task, parentContext, agentName, useSearch }) => {
        try {
            const systemPrompt = `You are a specialized sub-agent named "${agentName || 'Agent'}". Your ONLY job is to complete this specific task. Be focused, concise, and return only the result. Context from parent: ${parentContext || 'none'}.`;
            const reply = await callGemini(task, [], systemPrompt, useSearch === true);
            return { ok: true, reply, agentName: agentName || 'Agent' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ── Terminal ──────────────────────────────────────────────────────────────
    ipcMain.handle('run-terminal', async (_, { command, cwd, confirm }) => {
        // Honor the same kill switch as the bot-side enqueue path.
        if (isPcAgentDisabled()) {
            return { output: 'PC agent is disabled (PC_AGENT_DISABLED=1).', exitCode: 1 };
        }
        // The renderer is not trusted. Enforce hard-blocks even when it passes
        // confirm=true, then allow only confirmable destructive forms.
        const gate = gateShellCommand(command, { confirm });
        if (!gate.ok) {
            return { output: gate.reason, exitCode: 1 };
        }
        return new Promise(resolve => {
            exec(command, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash', timeout: 60000, cwd: cwd || undefined }, (err, stdout, stderr) => {
                resolve({ output: (stdout || stderr || (err ? err.message : '')).trim(), exitCode: err?.code || 0 });
            });
        });
    });

    // ── File System ───────────────────────────────────────────────────────────
    ipcMain.handle('read-dir', async (_, dirPath) => {
        // Containment: only roots main itself handed out are listable.
        const resolved = resolveInAllowedRoot(dirPath);
        if (!resolved) return { ok: false, error: 'path is outside the allowed workspace', items: [] };
        try {
            const items = fs.readdirSync(resolved, { withFileTypes: true });
            return { ok: true, items: items.map(i => ({ name: i.name, isDir: i.isDirectory(), path: path.join(resolved, i.name) })) };
        } catch (err) { return { ok: false, error: err.message, items: [] }; }
    });

    ipcMain.handle('read-file', async (_, filePath) => {
        // Kill switch gates filesystem reads too, not just the terminal.
        if (isPcAgentDisabled()) return { ok: false, error: 'PC agent is disabled (PC_AGENT_DISABLED=1).' };
        const resolved = resolveInAllowedRoot(filePath);
        if (!resolved) return { ok: false, error: 'path is outside the allowed workspace' };
        try { return { ok: true, content: fs.readFileSync(resolved, 'utf8') }; }
        catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('write-file', async (_, { filePath, content }) => {
        // Kill switch gates filesystem writes too, not just the terminal.
        if (isPcAgentDisabled()) return { ok: false, error: 'PC agent is disabled (PC_AGENT_DISABLED=1).' };
        const resolved = resolveInAllowedRoot(filePath);
        if (!resolved) return { ok: false, error: 'path is outside the allowed workspace' };
        if (isSensitiveWritePath(resolved)) return { ok: false, error: 'refusing to write to a sensitive path (Startup/.env/.ssh/.git hooks)' };
        try { fs.writeFileSync(resolved, content, 'utf8'); return { ok: true }; }
        catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('open-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
        if (result.canceled) return null;
        const folder = result.filePaths[0];
        // The user explicitly picked this folder — it becomes an allowed root.
        addAllowedFsRoot(folder);
        return folder;
    });

    // ── Settings / API Keys ───────────────────────────────────────────────────
    ipcMain.handle('get-config', async () => {
        const keys = ['GEMINI_API_KEY', 'DISCORD_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY', 'githubToken'];
        const c = loadConfig();
        const result = {};
        for (const k of keys) {
            const val = c[k] || getEnv(k);
            result[k] = val ? val.slice(0, 6) + '••••••••' + val.slice(-4) : '';
        }
        return { ok: true, config: result };
    });

    ipcMain.handle('save-config-key', async (_, { key, value }) => {
        try {
            saveConfig({ [key]: value });
            // Also update process.env
            process.env[key] = value;
            return { ok: true };
        } catch (err) { return { ok: false, error: err.message }; }
    });

    // ── GitHub ────────────────────────────────────────────────────────────────
    ipcMain.handle('github-load-saved', async () => {
        const token = getEnv('githubToken');
        if (!token) return { ok: false };
        try {
            const res = await githubRequest('/user', token);
            if (res.status !== 200) return { ok: false };
            return { ok: true, user: res.body.login, avatar: res.body.avatar_url };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('github-connect', async (_, token) => {
        try {
            const res = await githubRequest('/user', token);
            if (res.status !== 200) throw new Error(res.body.message || 'Auth failed');
            saveConfig({ githubToken: token });
            return { ok: true, user: res.body.login, avatar: res.body.avatar_url };
        } catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('github-cli-auth', () => {
        return new Promise(resolve => {
            exec('gh auth token', { timeout: 5000 }, (err, stdout) => {
                if (err) resolve({ ok: false });
                else {
                    const token = stdout.trim();
                    if (!token) resolve({ ok: false });
                    else resolve({ ok: true, token });
                }
            });
        });
    });

    ipcMain.handle('github-repos', async () => {
        const token = getEnv('githubToken');
        if (!token) return { ok: false, error: 'Not connected to GitHub' };
        try {
            let allRepos = [];
            let page = 1;
            while (true) {
                const res = await githubRequest(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`, token);
                if (res.status !== 200) {
                    if (page === 1) throw new Error(res.body.message || 'Failed to fetch repos');
                    break;
                }
                if (!res.body || res.body.length === 0) break;
                allRepos = allRepos.concat(res.body);
                if (res.body.length < 100) break;
                page++;
            }
            
            const repos = allRepos.map(r => ({
                id: r.id, name: r.name, fullName: r.full_name,
                description: r.description || '', language: r.language || '',
                stars: r.stargazers_count, private: r.private,
                url: r.clone_url, sshUrl: r.ssh_url, updatedAt: r.updated_at,
                fork: r.fork
            }));
            
            // Re-sort locally as GitHub sorting can be wonky across pages
            repos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            
            return { ok: true, repos };
        } catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('github-clone', async (_, { cloneUrl, repoName }) => {
        const os = require('os');
        // The renderer is untrusted: validate URL + repo name in main, then
        // clone via execFile argv (no cmd.exe string, no quote breakout).
        const valid = validateCloneRequest(cloneUrl, repoName);
        if (!valid.ok) return { ok: false, error: valid.error };
        const targetDir = path.join(os.homedir(), 'EvilIreneRepos');

        // Ensure the global workspace directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const destPath = path.join(targetDir, repoName);

        // Check if we already cloned it
        if (fs.existsSync(destPath)) {
            addAllowedFsRoot(destPath);
            return { ok: true, path: destPath, output: 'Already cloned! Opening local copy...' };
        }

        return new Promise(resolve => {
            execFile('git', ['clone', String(cloneUrl), destPath], { timeout: 120000 }, (err, stdout, stderr) => {
                const out = (stdout + stderr).trim();
                if (err && !fs.existsSync(destPath)) resolve({ ok: false, error: out || err.message });
                else {
                    // The clone destination becomes an allowed FS root so the
                    // explorer/editor can browse it.
                    addAllowedFsRoot(destPath);
                    resolve({ ok: true, path: destPath, output: out });
                }
            });
        });
    });

    ipcMain.handle('github-pull', async (_, folderPath) => {
        // git pull runs repo hooks — only allow it inside allowlisted roots.
        const resolved = resolveInAllowedRoot(folderPath);
        if (!resolved) return { ok: false, output: 'path is outside the allowed workspace' };
        return new Promise(resolve => {
            execFile('git', ['pull'], { cwd: resolved, timeout: 30000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, output: (stdout + stderr).trim() });
            });
        });
    });

    ipcMain.handle('github-status', async (_, folderPath) => {
        const resolved = resolveInAllowedRoot(folderPath);
        if (!resolved) return { ok: false, output: 'path is outside the allowed workspace' };
        return new Promise(resolve => {
            execFile('git', ['status'], { cwd: resolved, timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, output: (stdout + stderr).trim() });
            });
        });
    });

    ipcMain.handle('github-disconnect', async () => {
        saveConfig({ githubToken: null });
        return { ok: true };
    });

    // ── Window controls ────────────────────────────────────────────────────────
    ipcMain.handle('get-status', () => ({ connected: isConnected, commands: commandsExecuted }));
    ipcMain.on('close-app', () => app.quit());
    ipcMain.on('minimize-app', () => mainWindow?.minimize());
    ipcMain.on('maximize-app', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
    ipcMain.on('open-external', (_, url) => {
        if (!isAllowedExternalUrl(url)) return;
        shell.openExternal(String(url));
    });
});

if (app) app.on('window-all-closed', () => app.quit());
