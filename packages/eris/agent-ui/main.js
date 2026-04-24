const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

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

// ─── ELECTRON ────────────────────────────────────────────────────────────────
const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
const dialog = electron.dialog;
const shell = electron.shell;

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
            webSecurity: false
        },
        title: 'Eris IDE'
    });
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
async function pollCommands() {
    if (!supabase || !isConnected) return;
    try {
        const { data: commands, error } = await supabase
            .from('local_commands').select('*').eq('status', 'pending')
            .order('created_at', { ascending: true }).limit(5);
        if (error || !commands?.length) return;
        for (const cmd of commands) {
            await supabase.from('local_commands').update({ status: 'running' }).eq('id', cmd.id);
            mainWindow?.webContents.send('agent-command-start', { command: cmd.command, id: cmd.id });
            exec(cmd.command, { shell: 'powershell.exe', timeout: 30000 }, async (err, stdout, stderr) => {
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
app.whenReady().then(() => {
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
    ipcMain.handle('run-terminal', async (_, { command, cwd }) => {
        return new Promise(resolve => {
            exec(command, { shell: 'powershell.exe', timeout: 60000, cwd: cwd || undefined }, (err, stdout, stderr) => {
                resolve({ output: (stdout || stderr || (err ? err.message : '')).trim(), exitCode: err?.code || 0 });
            });
        });
    });

    // ── File System ───────────────────────────────────────────────────────────
    ipcMain.handle('read-dir', async (_, dirPath) => {
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            return { ok: true, items: items.map(i => ({ name: i.name, isDir: i.isDirectory(), path: path.join(dirPath, i.name) })) };
        } catch (err) { return { ok: false, error: err.message, items: [] }; }
    });

    ipcMain.handle('read-file', async (_, filePath) => {
        try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') }; }
        catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('write-file', async (_, { filePath, content }) => {
        try { fs.writeFileSync(filePath, content, 'utf8'); return { ok: true }; }
        catch (err) { return { ok: false, error: err.message }; }
    });

    ipcMain.handle('open-folder-dialog', async () => {
        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
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
        const targetDir = path.join(os.homedir(), 'EvilIreneRepos');
        
        // Ensure the global workspace directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const destPath = path.join(targetDir, repoName);
        
        // Check if we already cloned it 
        if (fs.existsSync(destPath)) {
            return { ok: true, path: destPath, output: 'Already cloned! Opening local copy...' };
        }
        
        return new Promise(resolve => {
            exec(`git clone "${cloneUrl}" "${destPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
                const out = (stdout + stderr).trim();
                if (err && !fs.existsSync(destPath)) resolve({ ok: false, error: out || err.message });
                else resolve({ ok: true, path: destPath, output: out });
            });
        });
    });

    ipcMain.handle('github-pull', async (_, folderPath) => {
        return new Promise(resolve => {
            exec('git pull', { cwd: folderPath, timeout: 30000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, output: (stdout + stderr).trim() });
            });
        });
    });

    ipcMain.handle('github-status', async (_, folderPath) => {
        return new Promise(resolve => {
            exec('git status', { cwd: folderPath, timeout: 10000 }, (err, stdout, stderr) => {
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
    ipcMain.on('open-external', (_, url) => shell.openExternal(url));
});

app.on('window-all-closed', () => app.quit());
