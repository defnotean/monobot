// ─── DESTRUCTIVE-COMMAND GATE (renderer copy) ──────────────────────────────────
// SOURCE OF TRUTH: packages/eris/utils/pcAgent.js (~40-134). Duplicated here
// because the renderer is a sandboxed browser context with no `require`. Used to
// force a hard confirm on destructive plan steps even when auto-approve is on —
// LLM-authored plans are NOT trusted to be non-destructive.
const _WS = "[\\s\\u00A0\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]";
const _DESTRUCTIVE_PATTERNS = [
    new RegExp(`\\brm${_WS}+(-[a-z]*[rfRF][a-z]*${_WS}+)?[\\/~]`, "iu"),
    new RegExp(`\\brm${_WS}+-[a-z]*[rfRF]`, "iu"),
    new RegExp(`\\b(del|erase)${_WS}+\\/[sfq]`, "iu"),
    new RegExp(`\\b(rmdir|rd)${_WS}+\\/s`, "iu"),
    new RegExp(`\\brd${_WS}+(-[a-z]*[rfRF][a-z]*${_WS}+)?[\\/~]`, "iu"),
    new RegExp(`\\bformat${_WS}+[a-z]:`, "iu"),
    /\bdiskpart\b/iu,
    new RegExp(`\\bmkfs(\\.|${_WS})`, "iu"),
    new RegExp(`\\bdd${_WS}+[^|]*\\bof=\\/dev\\/`, "iu"),
    /\b:(?:\(\s*\)\s*\{\s*:\|:&\s*\}\s*;\s*:|\s*\(\)\s*\{\s*:\|:)/iu,
    new RegExp(`\\breg${_WS}+delete\\b`, "iu"),
    new RegExp(`\\bsc${_WS}+delete\\b`, "iu"),
    /\bshutdown\b/iu,
    new RegExp(`\\bnet${_WS}+user\\b.*\\/(add|delete)`, "iu"),
    new RegExp(`\\btakeown${_WS}+\\/f`, "iu"),
    /\bicacls\b.*\/deny/iu,
    new RegExp(`\\b(?:Remove-Item|ri|rd|rm|del|erase|rmdir)\\b(?=[^|]*${_WS}-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?\\b)(?=[^|]*${_WS}-f(?:o(?:r(?:ce?)?)?)?\\b)`, "iu"),
    /\bStop-Computer\b/iu,
    /\bRestart-Computer\b/iu,
    /\bClear-EventLog\b/iu,
    /(?:^|[^-=>])>{1,2}(?!&)/u,
    /\b(?:Set-Content|Add-Content|Out-File|Tee-Object)\b/iu,
    /\[(?:System\.)?IO\.File\]\s*::\s*Write/iu,
    new RegExp(`\\bpowershell(\\.exe)?\\b[^|]*${_WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bpwsh(\\.exe)?\\b[^|]*${_WS}-(EncodedCommand|enc|ec|e)\\b`, "iu"),
    new RegExp(`\\bcmd(\\.exe)?\\b[^|]*${_WS}\\/c\\b`, "iu"),
];
const _CHAIN_SPLIT = /(?:&&|\|\||;|\||&|`|\$\(|>{1,2})/u;
function _normalizeForMatch(command) {
    if (typeof command !== 'string') return '';
    let s;
    try { s = command.normalize('NFKC'); } catch { s = command; }
    return s.replace(/[​-‍⁠﻿­]/g, '');
}
function _matchDestructive(normalized) {
    for (const pat of _DESTRUCTIVE_PATTERNS) { if (pat.test(normalized)) return pat.source; }
    return null;
}
function looksDestructive(command) {
    if (!command || typeof command !== 'string') return null;
    const normalized = _normalizeForMatch(command);
    if (!normalized) return null;
    const whole = _matchDestructive(normalized);
    if (whole) return whole;
    if (_CHAIN_SPLIT.test(normalized)) {
        for (const part of normalized.split(_CHAIN_SPLIT)) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const hit = _matchDestructive(trimmed);
            if (hit) return hit;
        }
    }
    return null;
}

// Strict read-only allowlist — the ONLY commands an LLM-authored terminal plan
// step may run without a per-step human confirmation. Anchored and intentionally
// narrow: anything chained, redirected, multi-line, or simply not listed here
// requires the owner to confirm the exact command first.
const _READONLY_ALLOWLIST = [
    /^(?:Get-ChildItem|dir|ls)(?:\s+[^<>|;&(){}$`]*)?$/i,
    /^(?:Get-Content|type|cat)\s+[^<>|;&(){}$`]+$/i,
    /^Get-Process(?:\s+[^<>|;&(){}$`]*)?$/i,
    /^git\s+(?:status|log|diff|branch)(?:\s+[^<>|;&(){}$`]*)?$/i,
    /^node\s+--version$/i,
    /^npm\s+ls(?:\s+[^<>|;&(){}$`]*)?$/i,
    /^(?:pwd|Get-Location)$/i,
    /^whoami$/i,
    /^systeminfo$/i,
];
function isReadOnlyCommand(command) {
    if (!command || typeof command !== 'string') return false;
    const cmd = _normalizeForMatch(command).trim();
    if (!cmd) return false;
    // No multi-statement smuggling: newlines, chain operators, pipes,
    // redirection, backticks, and subexpressions all disqualify.
    if (/[\r\n]/.test(cmd) || _CHAIN_SPLIT.test(cmd)) return false;
    // PowerShell command-grouping `( ... )` and script blocks `{ ... }` execute
    // their contents just like `$(...)` does — e.g. `Get-Content (Start-Process x)`
    // runs Start-Process. `$` alone covers variable/member smuggling. Reject all
    // grouping/expansion characters outright before consulting the allowlist.
    if (/[(){}$]/.test(cmd)) return false;
    return _READONLY_ALLOWLIST.some(re => re.test(cmd));
}

// Resolve a model-authored relative file path inside currentFolder, rejecting
// `..` traversal and absolute-path escapes. Returns the contained absolute path,
// or null if the path would escape the selected folder. Handles both `/` and
// `\\` separators so Windows hosts are covered too.
function resolveInFolder(folder, rel) {
    if (!folder) return null;
    const r = String(rel || '');
    // Reject absolute paths (POSIX `/...`, Windows `C:\\...` / `\\\\unc`).
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(r)) return null;
    const sep = folder.includes('\\') ? '\\' : '/';
    const baseParts = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
    const parts = baseParts.slice();
    for (const seg of r.split(/[\\/]/)) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') return null; // never allow climbing out
        parts.push(seg);
    }
    const resolved = parts.join(sep);
    // Final containment guard: resolved must start with the base + separator.
    const baseNorm = baseParts.join(sep);
    if (resolved !== baseNorm && !resolved.startsWith(baseNorm + sep)) return null;
    return resolved;
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let editor = null, monacoReady = false;
let openTabs = [], activeTab = null;
let sessions = [{ id: 0, name: 'Main session', history: [] }];
let activeSessionId = 0;
let isConnected = false, isBusy = false;
let autoApprove = false;
let currentFolder = null;
let allRepos = [];
let termHistory = [], termIdx = -1;

// ─── MONACO ────────────────────────────────────────────────────────────────────
function createPlainTextEditor() {
    const wrap = document.getElementById('editor-wrap');
    if (!wrap) return;
    const textarea = document.createElement('textarea');
    textarea.className = 'plain-editor';
    textarea.spellcheck = false;
    textarea.style.cssText = [
        'display:none',
        'width:100%',
        'height:100%',
        'box-sizing:border-box',
        'resize:none',
        'border:0',
        'outline:0',
        'padding:12px',
        'background:#0d0e10',
        'color:#e2e3ec',
        'font:13px/22px "JetBrains Mono", monospace'
    ].join(';');
    let changeHandler = null;
    textarea.addEventListener('input', () => changeHandler && changeHandler());
    textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveFile();
        }
    });
    wrap.appendChild(textarea);
    editor = {
        getValue: () => textarea.value,
        setValue: (value) => { textarea.value = value || ''; },
        getDomNode: () => textarea,
        layout: () => {},
        addCommand: () => {},
        onDidChangeModelContent: (handler) => { changeHandler = handler; },
    };
    monacoReady = true;
    const noEditor = document.getElementById('no-editor');
    if (noEditor) noEditor.style.display = 'flex';
    editor.onDidChangeModelContent(() => {
        const t = openTabs.find(x => x.path === activeTab);
        if (t && !t.dirty) { t.dirty = true; renderTabs(); }
    });
}

function bootstrapLocalMonaco() {
if (typeof monaco === 'undefined' || !monaco.editor) return false;
    monaco.editor.defineTheme('irene', {
        base: 'vs-dark', inherit: true,
        rules: [
            { token: 'comment', foreground: '3a3c4e', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'e8294a' },
            { token: 'string', foreground: '22c55e' },
            { token: 'number', foreground: '6366f1' },
        ],
        colors: {
            'editor.background': '#0d0e10', 'editor.foreground': '#e2e3ec',
            'editorLineNumber.foreground': '#252830', 'editorLineNumber.activeForeground': '#e8294a',
            'editor.selectionBackground': '#e8294a22', 'editorCursor.foreground': '#e8294a',
            'editor.lineHighlightBackground': '#111318', 'editorWidget.background': '#181a20',
            'scrollbarSlider.background': '#1e2028',
        }
    });
    editor = monaco.editor.create(document.getElementById('editor-wrap'), {
        theme: 'irene', language: 'javascript', value: '',
        fontSize: 13, fontFamily: 'JetBrains Mono, monospace', lineHeight: 22,
        minimap: { enabled: false }, scrollBeyondLastLine: false,
        smoothScrolling: true, cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on', padding: { top: 12, bottom: 12 },
        automaticLayout: true,
    });
    monacoReady = true;
    document.getElementById('no-editor').style.display = 'flex';
    editor.getDomNode().style.display = 'none';
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
    editor.onDidChangeModelContent(() => {
        const t = openTabs.find(x => x.path === activeTab);
        if (t && !t.dirty) { t.dirty = true; renderTabs(); }
    });
return true;
}

// Use only renderer-local code. If a local Monaco bundle has been provided by
// the app shell, use it; otherwise fall back to a plaintext editor.
if (typeof document !== 'undefined') {
    if (!bootstrapLocalMonaco()) createPlainTextEditor();
    bindStaticUiEvents();
}

// Exported for unit tests when loaded under CommonJS (no DOM). In the browser
// `module` is undefined so this is a no-op.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { looksDestructive, resolveInFolder, isReadOnlyCommand };
}

// ─── MODE ─────────────────────────────────────────────────────────────────────
function setMode(mode) {
    ['chat', 'code', 'terminal'].forEach(m => {
        const v = document.getElementById(`view-${m}`);
        if (v) v.style.display = m === mode ? 'flex' : 'none';
        if (m === 'code') v.style.flexDirection = 'column';
    });
    document.querySelectorAll('.mtab').forEach((t, i) => {
        t.classList.toggle('active', ['chat','code','terminal'][i] === mode);
    });
    if (mode === 'code' && monacoReady) editor.layout();
}

// ─── CONNECT ──────────────────────────────────────────────────────────────────
async function toggleConnect() {
    const btn = document.getElementById('conn-btn');
    const label = document.getElementById('conn-label');
    if (isConnected) {
        await agent.disconnect();
        setConnState(false);
        addToolCall('🔌', 'Disconnected from Supabase', '', true);
    } else {
        label.textContent = 'Connecting…';
        btn.disabled = true;
        const r = await agent.connect();
        btn.disabled = false;
        if (r.ok) {
            setConnState(true);
            addIreneMsg("ok i'm connected. what are we building 😈");
        } else {
            label.textContent = 'Connect';
            addToolCall('❌', 'Connection failed', r.error, true);
        }
    }
}

function setConnState(on) {
    isConnected = on;
    const btn = document.getElementById('conn-btn');
    const dot = document.getElementById('tb-dot');
    const inp = document.getElementById('chat-in');
    const send = document.getElementById('send-btn');
    btn.className = 'conn-btn' + (on ? ' on' : '');
    document.getElementById('conn-label').textContent = on ? 'Connected' : 'Connect';
    dot.className = 'tb-indicator' + (on ? ' on' : '');
    inp.disabled = !on; send.disabled = !on;
    document.getElementById('input-hint').textContent = on ? 'Shift+Enter for new line  ·  plans auto-break complex tasks' : 'Connect to start chatting';
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
function chatKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }
function autoResize(el) { el.style.height = '22px'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function toggleAuto() {
    autoApprove = !autoApprove;
    document.getElementById('auto-toggle').classList.toggle('on', autoApprove);
}

async function sendChat() {
    const input = document.getElementById('chat-in');
    const msg = input.value.trim();
    if (!msg || isBusy) return;
    input.value = ''; input.style.height = '22px';
    document.getElementById('welcome')?.remove();

    addUserMsg(msg);
    isBusy = true; document.getElementById('send-btn').disabled = true;

    const session = sessions.find(s => s.id === activeSessionId);
    const history = session?.history || [];

    // Decide if this is a coding/task request that needs a plan
    const taskKeywords = /\b(build|create|make|write|implement|fix|add|refactor|clone|research|find|analyze|investigate|compare)\b/i;
    const needsPlan = taskKeywords.test(msg) && msg.length > 30;

    const typing = addTyping();

    if (needsPlan) {
        // Phase 1: Generate implementation plan via sub-agent
        const planResult = await agent.spawnSubagent({
            task: `Analyze this request and return a JSON implementation plan: "${msg}"\n\nReturn ONLY valid JSON in this exact format:\n{"title":"<short title>","steps":[{"title":"<step title>","desc":"<what will be done>","type":"<code|terminal|research|analysis>"}]}\n\nMax 6 steps. Be specific and actionable.`,
            parentContext: `Working folder: ${currentFolder || 'not set'}. Session history items: ${history.length}`,
            agentName: 'Planner'
        });

        typing.remove();

        let plan = null;
        if (planResult.ok) {
            try {
                const jsonMatch = planResult.reply.match(/\{[\s\S]*\}/);
                if (jsonMatch) plan = JSON.parse(jsonMatch[0]);
            } catch {}
        }

        if (plan?.steps?.length) {
            const planEl = addPlan(plan, msg, history);

            // Auto-approve if toggle is on
            if (autoApprove) {
                setTimeout(() => executePlan(planEl, plan, msg, history), 600);
            }
        } else {
            // Fall back to regular chat
            const r = await agent.chatIrene({ message: msg, history });
            if (r.ok) {
                history.push({ role: 'user', text: msg }, { role: 'model', text: r.reply });
                addIreneMsg(r.reply);
            } else addToolCall('❌', 'Error', r.error, true);
        }
    } else {
        // Regular conversational response
        const r = await agent.chatIrene({ message: msg, history });
        typing.remove();
        if (r.ok) {
            history.push({ role: 'user', text: msg }, { role: 'model', text: r.reply });
            if (history.length > 40) history.splice(0, 2);
            addIreneMsg(r.reply);
        } else addToolCall('❌', 'Error', r.error, true);
    }

    isBusy = false; document.getElementById('send-btn').disabled = !isConnected;
}

// ─── IMPLEMENTATION PLAN ──────────────────────────────────────────────────────
function executeStoredPlan(btn) {
    const wrap = btn.closest('.msg-wrap');
    if (wrap && wrap._plan) {
        executePlan(wrap, wrap._plan, wrap._msg, wrap._history);
    }
}

function addPlan(plan, originalMsg, history) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    const id = 'plan-' + Date.now();
    wrap.innerHTML = `
    <div class="msg-row irene">
      <div class="avatar irene">😈</div>
      <div class="msg-body">
        <div class="msg-sender">irene · planner</div>
        <div class="plan-card" id="${id}">
          <div class="plan-header">
            <span class="plan-title">${esc(plan.title)}</span>
            <span class="plan-badge planning" id="${id}-badge">Planning</span>
          </div>
          <div class="plan-steps" id="${id}-steps">
            ${plan.steps.map((s, i) => `
              <div class="plan-step" id="${id}-step-${i}">
                <div class="step-num">${i+1}</div>
                <div class="step-info">
                  <div class="step-title">${esc(s.title)}</div>
                  <div class="step-desc">${esc(s.desc)}</div>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="plan-actions">
            <button class="plan-approve-btn" id="${id}-approve">▶ Approve & Execute</button>
            <button class="plan-cancel-btn" style="padding:7px 14px;border-radius:8px;background:none;border:1px solid var(--border);color:var(--text2);font-size:12px">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;
    document.getElementById('messages').appendChild(wrap);
    scrollChat();

    wrap._plan = plan; wrap._msg = originalMsg; wrap._history = history;
    // CSP forbids inline handlers — bind the plan actions here instead.
    const approveBtn = wrap.querySelector('.plan-approve-btn');
    if (approveBtn) approveBtn.addEventListener('click', () => executeStoredPlan(approveBtn));
    const cancelBtn = wrap.querySelector('.plan-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
        const actions = wrap.querySelector('.plan-actions');
        if (actions) actions.innerHTML = '<span style="color:var(--text3);font-size:12px">Plan cancelled</span>';
    });
    return wrap;
}

async function executePlan(planWrap, plan, originalMsg, history) {
    const id = planWrap.querySelector('.plan-card')?.id;
    if (!id) return;

    const badge = document.getElementById(`${id}-badge`);
    const approveBtn = document.getElementById(`${id}-approve`);
    if (badge) { badge.textContent = 'Running'; badge.className = 'plan-badge running'; }
    if (approveBtn) approveBtn.disabled = true;

    const results = [];

    for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const stepEl = document.getElementById(`${id}-step-${i}`);
        if (stepEl) stepEl.className = 'plan-step running';

        let output = '';
        let stepLogs = [];

        if (step.type === 'research') {
            const r = await agent.spawnSubagent({
                task: step.desc + '\n\nOriginal request: ' + originalMsg + '\nUse web search to find accurate, current information. Summarize findings.',
                parentContext: results.map((r, j) => `Step ${j+1}: ${r}`).join('\n'),
                agentName: `Research: ${step.title}`,
                useSearch: true
            });
            output = r.ok ? r.reply : `Error: ${r.error}`;
            if (r.ok) stepLogs.push(`Searched the web for: ${step.title}`);
        } else if (step.type === 'terminal') {
            // LLM-authored plan steps are NOT trusted. Terminal steps ALWAYS
            // require a per-step confirmation showing the exact command — even
            // with auto-approve on — unless the command matches the strict
            // read-only allowlist. Confirm is forwarded to the host gate only
            // when the owner explicitly accepted the exact command.
            const command = step.desc;
            const destructive = looksDestructive(command);
            let confirmed = false;
            let approved = !destructive && isReadOnlyCommand(command);
            if (!approved) {
                const warning = destructive
                    ? `This plan step looks DESTRUCTIVE (matched /${destructive}/):`
                    : 'This plan step wants to run a terminal command:';
                confirmed = window.confirm(`${warning}\n\n${command}\n\nRun it?`);
                approved = confirmed;
            }
            if (!approved) {
                output = `(blocked: terminal step not confirmed)`;
                stepLogs.push(`⛔ Blocked terminal step (not confirmed): ${command}`);
            } else {
                const r = await agent.runTerminal({ command, cwd: currentFolder, confirm: confirmed });
                output = r.output || '(done)';
                stepLogs.push(`Executed: ${command}`);
            }
        } else {
            // Code/analysis step
            const workspacePrompt = `You have full autonomous capability. Your working directory is ${currentFolder || 'unknown'}. 
To view files, use Powershell commands like 'Get-Content'.
To write to a file, output EXACTLY this format and nothing else around it for that file (I will intercept it):
[WRITE_FILE_START: filename.js]
the code content inside
[WRITE_FILE_END]`;

            const r = await agent.spawnSubagent({
                task: step.desc + '\n\nContext: ' + originalMsg + '\n\n' + workspacePrompt,
                parentContext: results.slice(-2).join('\n'),
                agentName: step.title
            });
            
            output = r.ok ? r.reply : `Error: ${r.error}`;
            
            // Intercept file edits
            if (r.ok && output.includes('[WRITE_FILE_START:')) {
                const regex = /\[WRITE_FILE_START:\s*(.+?)\]([\s\S]*?)\[WRITE_FILE_END\]/g;
                let match;
                while ((match = regex.exec(output)) !== null) {
                    const rel = match[1].trim();
                    const content = match[2].trim();
                    // Constrain LLM-authored writes to the selected folder subtree:
                    // reject `..` traversal and absolute-path escapes.
                    if (!currentFolder) {
                        stepLogs.push(`❌ Refused to write ${rel}: no working folder selected`);
                        continue;
                    }
                    const filePath = resolveInFolder(currentFolder, rel);
                    if (!filePath) {
                        stepLogs.push(`⛔ Refused to write outside working folder: ${rel}`);
                        continue;
                    }
                    const wr = await agent.writeFile({ filePath, content });
                    if (wr.ok) {
                        stepLogs.push(`✅ Edited file: ${rel}`);
                    } else {
                        stepLogs.push(`❌ Failed to edit: ${rel} (${wr.error})`);
                    }
                }
                output = output.replace(regex, '*(Automatically edited files)*');
            } else {
                stepLogs.push('Analyzed codebase elements.');
            }
        }

        results.push(output);

        if (stepEl) {
            stepEl.className = 'plan-step done';
            const info = stepEl.querySelector('.step-info');
            if (info) {
                const outEl = document.createElement('div');
                outEl.className = 'step-output';
                appendTextLines(outEl, stepLogs.join('\n'));
                outEl.appendChild(document.createElement('br'));
                const outputEl = document.createElement('span');
                outputEl.style.opacity = '0.5';
                outputEl.textContent = output.length > 300 ? '...output truncated' : output;
                outEl.appendChild(outputEl);
                info.appendChild(outEl);
            }
        }
        scrollChat();
    }


    // Final synthesis
    if (badge) { badge.textContent = 'Synthesizing…'; }
    const synthResult = await agent.chatIrene({
        message: `I've completed the implementation plan for: "${originalMsg}"\n\nHere are results from each step:\n${results.map((r, i) => `Step ${i+1} (${plan.steps[i].title}):\n${r}`).join('\n\n')}\n\nPlease give a final concise summary of what was accomplished and any next steps.`,
        history
    });

    if (badge) { badge.textContent = 'Done'; badge.className = 'plan-badge done'; }
    const actions = document.querySelector(`#${id} .plan-actions`);
    if (actions) actions.innerHTML = '<span style="color:var(--green);font-size:12px">✓ Completed</span>';

    if (synthResult.ok) addIreneMsg(synthResult.reply);
    scrollChat();
}

// ─── RESEARCH DEEP DIVE ───────────────────────────────────────────────────────
// Called when user asks something research-heavy with multiple angles
async function deepResearch(query, angles) {
    addToolCall('🔍', `Deep research: ${query}`, `Spawning ${angles.length} research agents…`, true);
    const results = await Promise.all(angles.map(angle =>
        agent.spawnSubagent({
            task: `Research this specific angle: "${angle}" for the query: "${query}"\nBe thorough, cite specific facts. Use search.`,
            parentContext: '',
            agentName: angle,
            useSearch: true
        })
    ));
    return results.filter(r => r.ok).map(r => r.reply);
}

// ─── MESSAGE BUILDERS ─────────────────────────────────────────────────────────
function addUserMsg(text) {
    append(`<div class="msg-row user">
      <div class="avatar">🧑</div>
      <div class="msg-body">
        <div class="msg-sender">you</div>
        <div class="bubble user">${esc(text)}</div>
      </div></div>`);
}

function addIreneMsg(text) {
    append(`<div class="msg-row irene">
      <div class="avatar irene">😈</div>
      <div class="msg-body">
        <div class="msg-sender">irene</div>
        <div class="bubble irene">${esc(text)}</div>
      </div></div>`);
}

function addToolCall(icon, label, body, expanded = false) {
    const id = 'tc-' + Date.now();
    const wrap = append(`<div class="tool-call${expanded?' open':''}" id="${id}">
      <div class="tool-call-header">
        <span class="tool-call-icon">${icon}</span>
        <span class="tool-call-label">${esc(label)}</span>
        <span class="tool-call-chevron">›</span>
      </div>
      ${body ? `<div class="tool-call-body">${esc(body)}</div>` : ''}
    </div>`);
    // CSP forbids inline handlers — bind the expand toggle here instead.
    const header = wrap.querySelector('.tool-call-header');
    if (header) header.addEventListener('click', () => {
        wrap.querySelector('.tool-call')?.classList.toggle('open');
    });
}

function addSubagentCard(name, output) {
    append(`<div class="subagent-card">
      <div class="subagent-header">🤖 Sub-agent: ${esc(name)}</div>
      <div class="subagent-body">${esc(output)}</div>
    </div>`);
}

function addTyping() {
    const id = 'typing-' + Date.now();
    append(`<div class="msg-row irene" id="${id}">
      <div class="avatar irene">😈</div>
      <div class="msg-body">
        <div class="typing"><div class="td"></div><div class="td"></div><div class="td"></div></div>
      </div></div>`);
    return { remove: () => document.getElementById(id)?.remove() };
}

function append(html) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    wrap.innerHTML = html;
    document.getElementById('messages').appendChild(wrap);
    scrollChat();
    return wrap;
}
function appendTextLines(parent, text) {
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (i) parent.appendChild(document.createElement('br'));
        parent.appendChild(document.createTextNode(line));
    });
}
function scrollChat() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }
function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                 .replace(/"/g,'&quot;').replace(/\n/g,'<br>');
}

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
function newSession() {
    const id = Date.now();
    sessions.push({ id, name: 'Session ' + sessions.length, history: [] });
    activeSessionId = id;
    document.getElementById('messages').innerHTML = '';
    document.getElementById('welcome')?.remove();
    renderSessions();
}

function renderSessions() {
    const list = document.getElementById('session-list');
    list.innerHTML = sessions.slice().reverse().map(s => `
        <div class="sb-item${s.id===activeSessionId?' active':''}" data-id="${s.id}">
          <span>💬</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>
        </div>`).join('');
    // CSP forbids inline handlers — bind the session switchers here instead.
    list.querySelectorAll('.sb-item').forEach(el => {
        el.addEventListener('click', () => switchSession(Number(el.dataset.id)));
    });
}

function switchSession(id) {
    activeSessionId = id;
    renderSessions();
}

// ─── GITHUB ───────────────────────────────────────────────────────────────────
async function githubConnect() {
    const token = document.getElementById('gh-token').value.trim();
    if (!token) return;
    document.getElementById('gh-token').value = '';
    addToolCall('🐙', 'Connecting to GitHub…', '', false);
    const r = await agent.githubConnect(token);
    if (r.ok) setGitHubUser(r);
    else addToolCall('❌', 'GitHub auth failed', r.error, true);
}

function setGitHubUser(r) {
    document.getElementById('gh-auth-ui').style.display = 'none';
    document.getElementById('gh-user-ui').style.display = 'block';
    document.getElementById('gh-avatar').src = r.avatar || '';
    document.getElementById('gh-username').textContent = r.user;
    addIreneMsg(`connected to github as @${r.user} — loading your repos`);
    loadRepos();
}

async function githubDisconnect() {
    await agent.githubDisconnect();
    document.getElementById('gh-auth-ui').style.display = 'block';
    document.getElementById('gh-user-ui').style.display = 'none';
    document.getElementById('repo-section').style.display = 'none';
}

async function loadRepos() {
    const btn = document.querySelector('#gh-user-ui .new-btn');
    if (btn) btn.textContent = '↻ Loading…';
    const r = await agent.githubRepos();
    if (btn) btn.innerHTML = '<span class="nb-icon">↻</span> Refresh repos';
    if (!r.ok) { addToolCall('❌', 'GitHub repos error', r.error, true); return; }
    allRepos = r.repos;
    document.getElementById('repo-count').textContent = `${allRepos.length}`;
    const section = document.getElementById('repo-section');
    section.style.display = 'flex';
    section.style.flexDirection = 'column';
    // Hide explorer when repos are shown
    document.getElementById('explorer-sec').style.display = 'none';
    renderRepos(allRepos);
}

function renderRepos(repos) {
    const list = document.getElementById('repo-list');
    list.innerHTML = '';
    repos.forEach(r => {
        const item = document.createElement('div');
        item.className = 'repo-item';
        item.addEventListener('click', () => cloneRepo(r.url, r.name));

        const name = document.createElement('div');
        name.className = 'repo-name';
        name.appendChild(document.createTextNode(r.name || ''));
        if (r.private) {
            const lock = document.createElement('span');
            lock.className = 'lock';
            lock.textContent = ' private';
            name.appendChild(lock);
        }
        if (r.fork) {
            const fork = document.createElement('span');
            fork.className = 'lock';
            fork.title = 'Fork';
            fork.textContent = ' fork';
            name.appendChild(fork);
        }
        item.appendChild(name);

        if (r.description) {
            const desc = document.createElement('div');
            desc.className = 'repo-desc';
            desc.textContent = r.description;
            item.appendChild(desc);
        }

        const meta = document.createElement('div');
        meta.className = 'repo-meta';
        if (r.language) {
            const dot = document.createElement('span');
            dot.className = `lang-dot lang-${String(r.language).toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
            dot.style.background = langColor(r.language);
            const lang = document.createElement('span');
            lang.textContent = r.language;
            meta.appendChild(dot);
            meta.appendChild(lang);
        }
        if (r.stars) {
            const stars = document.createElement('span');
            stars.textContent = `star ${r.stars}`;
            meta.appendChild(stars);
        }
        item.appendChild(meta);
        list.appendChild(item);
    });
}
function filterRepos(q) {
    const filtered = q ? allRepos.filter(r => r.name.toLowerCase().includes(q.toLowerCase()) || r.description.toLowerCase().includes(q.toLowerCase())) : allRepos;
    renderRepos(filtered);
}

async function cloneRepo(url, name) {
    addToolCall('⬇', `Cloning ${name}…`, '', false);
    const r = await agent.githubClone({ cloneUrl: url, repoName: name });
    if (r.ok) {
        addToolCall('✅', `Cloned ${name}`, r.path, true);
        addIreneMsg(`cloned ${name} to ${r.path} — opening in explorer`);
        await loadDir(r.path);
        setMode('code');
    } else if (!r.canceled) {
        addToolCall('❌', `Clone failed: ${name}`, r.error || 'Unknown error', true);
    }
}

function langColor(lang) {
    const map = { JavaScript: '#f7df1e', TypeScript: '#3178c6', Python: '#3572a5', HTML: '#e34c26', CSS: '#563d7c', Go: '#00add8', Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', Ruby: '#701516', Swift: '#f05138', Kotlin: '#a97bff' };
    return map[lang] || '#6b6e84';
}

// ─── FILE EXPLORER ───────────────────────────────────────────────────────────
async function openFolder() {
    const p = await agent.openFolderDialog();
    if (!p) return;
    currentFolder = p;
    await loadDir(p);
}

async function loadDir(dir, el) {
    let container = el;
    if (!container) {
        currentFolder = dir;
        container = document.getElementById('file-tree');
        container.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:8px">Loading...</div>';
        document.getElementById('explorer-sec').style.display = 'flex';
    }
    
    const r = await agent.readDir(dir);
    if (!r.ok) {
        if (!el) container.innerHTML = `<div style="color:var(--red);font-size:11px;padding:8px">Error: ${esc(r.error)}</div>`;
        return;
    }
    
    container.innerHTML = '';
    const sorted = r.items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    
    sorted.forEach(item => {
        const rowWrap = document.createElement('div');
        
        const row = document.createElement('div');
        row.className = 'ft-item';
        const chevron = item.isDir ? '<span class="ft-chev">›</span> ' : '<span style="width:12px;display:inline-block"></span>';
        row.innerHTML = `${chevron}${item.isDir ? '📁' : fileIcon(item.name)} ${esc(item.name)}`;
        
        const children = document.createElement('div');
        children.className = 'ft-children';
        children.style.display = 'none';
        children.style.paddingLeft = '14px';
        children.style.borderLeft = '1px solid var(--border2)';
        children.style.marginLeft = '6px';
        
        row.onclick = () => {
            if (item.isDir) {
                const isOpen = children.style.display === 'block';
                if (isOpen) {
                    children.style.display = 'none';
                    row.querySelector('.ft-chev').style.transform = 'rotate(0deg)';
                } else {
                    children.style.display = 'block';
                    row.querySelector('.ft-chev').style.transform = 'rotate(90deg)';
                    if (children.innerHTML === '') {
                        children.innerHTML = '<div style="color:var(--text3);font-size:10px;padding:4px">...</div>';
                        loadDir(item.path, children);
                    }
                }
            } else {
                openFile(item.path, item.name);
            }
        };
        
        rowWrap.appendChild(row);
        rowWrap.appendChild(children);
        container.appendChild(rowWrap);
    });
}

function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    return { js:'🟨', ts:'🔷', jsx:'🟧', tsx:'🟦', py:'🐍', html:'🌐', css:'🎨', json:'📋', md:'📝', sh:'💠', ps1:'💠', yml:'⚙', yaml:'⚙', rs:'🦀', go:'🐹' }[ext] || '📄';
}

// ─── CODE EDITOR ──────────────────────────────────────────────────────────────
async function openFile(filePath, name) {
    if (openTabs.find(t => t.path === filePath)) { activateTab(filePath); setMode('code'); return; }
    const r = await agent.readFile(filePath);
    if (!r.ok) { addToolCall('❌', 'Read error', r.error, true); return; }
    openTabs.push({ path: filePath, name, content: r.content, dirty: false });
    activateTab(filePath);
    setMode('code');
}

function activateTab(p) {
    if (activeTab) { const t = openTabs.find(x=>x.path===activeTab); if(t && editor) t.content = editor.getValue(); }
    activeTab = p;
    const tab = openTabs.find(t=>t.path===p);
    if (!tab || !monacoReady) return;
    const noEd = document.getElementById('no-editor');
    if (noEd) noEd.style.display = 'none';
    editor.getDomNode().style.display = '';
    const ext = p.split('.').pop().toLowerCase();
    const langMap = { js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript', py:'python', html:'html', css:'css', json:'json', md:'markdown', sh:'shell', ps1:'powershell', yml:'yaml', yaml:'yaml', rs:'rust', go:'go' };
    if (typeof monaco !== 'undefined' && monaco.editor && editor.setModel) {
        const model = monaco.editor.createModel(tab.content, langMap[ext]||'plaintext', monaco.Uri.file(p));
        const old = editor.getModel();
        editor.setModel(model);
        if (old) try { old.dispose(); } catch {}
    } else {
        editor.setValue(tab.content);
    }
    editor.layout();
    renderTabs();
}

function renderTabs() {
    const bar = document.getElementById('tab-bar');
    if (!openTabs.length) { bar.innerHTML = '<div class="no-editor" style="flex:1;flex-direction:row;gap:8px;font-size:12px;color:var(--text3)">Open a file from the explorer</div>'; return; }
    bar.innerHTML = openTabs.map(t => `
        <div class="etab${t.path===activeTab?' active':''}" data-path="${esc(t.path)}">
          ${t.dirty ? '<span style="color:var(--red)">●</span> ' : ''}${esc(t.name)}
          <span class="etab-close">×</span>
        </div>`).join('');
    // CSP forbids inline handlers — bind tab activate/close here instead.
    bar.querySelectorAll('.etab').forEach(el => {
        el.addEventListener('click', () => activateTab(el.dataset.path));
        el.querySelector('.etab-close')?.addEventListener('click', (event) => {
            event.stopPropagation();
            closeTab(el.dataset.path);
        });
    });
}

function closeTab(p) {
    openTabs = openTabs.filter(t => t.path !== p);
    if (activeTab === p) {
        activeTab = openTabs.at(-1)?.path || null;
        if (activeTab) activateTab(activeTab);
        else { editor?.getDomNode() && (editor.getDomNode().style.display='none'); document.getElementById('no-editor').style.display='flex'; }
    }
    renderTabs();
}

async function saveFile() {
    if (!activeTab || !editor) return;
    const t = openTabs.find(x => x.path === activeTab);
    if (!t) return;
    const content = editor.getValue();
    const r = await agent.writeFile({ filePath: activeTab, content });
    if (r.ok) { t.content = content; t.dirty = false; renderTabs(); termLog(`✓ Saved ${t.name}`, 'var(--green)'); }
    else addToolCall('❌', 'Save error', r.error, true);
}

// ─── TERMINAL ─────────────────────────────────────────────────────────────────
async function termKey(e) {
    const inp = document.getElementById('term-in');
    if (e.key === 'ArrowUp') { if (termIdx < termHistory.length-1) { termIdx++; inp.value = termHistory[termIdx]; } return; }
    if (e.key === 'ArrowDown') { if (termIdx > 0) { termIdx--; inp.value = termHistory[termIdx]; } else { termIdx=-1; inp.value=''; } return; }
    if (e.key !== 'Enter') return;
    const cmd = inp.value.trim(); if (!cmd) return;
    inp.value = ''; termHistory.unshift(cmd); termIdx = -1;
    termLog(`PS › ${cmd}`, 'var(--red)');
    // The host run-terminal gate blocks destructive matches unless confirm is
    // passed. The owner typed this command directly, so offer a hard confirm
    // override (mirrors the plan-step path) instead of silently refusing.
    const destructive = looksDestructive(cmd);
    let confirmed = false;
    if (destructive) {
        confirmed = window.confirm(`This command looks DESTRUCTIVE (matched /${destructive}/):\n\n${cmd}\n\nRun it anyway?`);
        if (!confirmed) {
            termLog(`⛔ Blocked destructive command (not confirmed)`, 'var(--red)');
            return;
        }
    }
    const r = await agent.runTerminal({ command: cmd, cwd: currentFolder, confirm: confirmed });
    termLog(r.output || '(no output)');
}

function termLog(text, color) {
    const out = document.getElementById('term-out');
    const line = document.createElement('div');
    if (color) line.style.color = color;
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
async function openSettings() {
    document.getElementById('settings-modal').classList.remove('hidden');
    // Load masked current values
    const r = await agent.getConfig();
    if (r.ok) {
        Object.entries(r.config).forEach(([k, v]) => {
            const el = document.getElementById(`key-${k}`);
            if (el && v) el.placeholder = v;
        });
    }
}
function closeSettings() { document.getElementById('settings-modal').classList.add('hidden'); }

async function saveKey(key) {
    const el = document.getElementById(`key-${key}`);
    const value = el.value.trim();
    if (!value) return;
    const r = await agent.saveConfigKey({ key, value });
    if (r.ok) {
        el.value = '';
        el.placeholder = value.slice(0,6) + '••••••••' + value.slice(-4);
        // If it's the github token, re-check connection
        if (key === 'githubToken') {
            const gr = await agent.githubLoadSaved();
            if (gr.ok) setGitHubUser(gr);
        }
        addToolCall('✅', `Saved ${key}`, '', false);
    } else addToolCall('❌', `Failed to save ${key}`, r.error, true);
}

// ─── AGENT EVENTS ─────────────────────────────────────────────────────────────
// Browser-only bootstrap: `agent` is injected by preload and is absent under a
// CommonJS test runner, so register listeners only when running in the page.
if (typeof agent !== 'undefined') {
agent.onCommandStart(d => {
    addToolCall('⚡', `PC command: ${String(d.command||d).slice(0,60)}`, d.command || d, false);
});
agent.onCommandDone(d => {
    termLog(`[agent] ${d.count} command(s) run`, 'var(--text3)');
});
}

async function githubCliConnect() {
    addToolCall('🐙', 'Connecting via GitHub CLI…', 'Running `gh auth token`', false);
    const btn = document.querySelector('#gh-auth-ui .new-btn');
    if (btn) btn.disabled = true;
    const r = await agent.runTerminal({command: 'gh auth token', cwd: ''});
    if (r.exitCode === 0 && r.output) {
        // use output as token
        const token = r.output.trim();
        document.getElementById('gh-token').value = token;
        await githubConnect();
    } else {
        addToolCall('❌', 'GH CLI Failed', 'Check if `gh` is installed and authenticated.', true);
        if (btn) btn.disabled = false;
    }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
// Static UI wiring. index.html carries no inline on* attributes (the CSP's
// script-src 'self' would block them) — every static control is bound here.
function bindStaticUiEvents() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    document.querySelector('.tb-close')?.addEventListener('click', () => agent.closeApp());
    document.querySelector('.tb-min')?.addEventListener('click', () => agent.minimizeApp());
    document.querySelector('.tb-max')?.addEventListener('click', () => agent.maximizeApp());
    document.querySelectorAll('.mtab').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
    on('settings-btn', 'click', openSettings);
    on('conn-btn', 'click', toggleConnect);
    on('open-folder-btn', 'click', openFolder);
    on('new-session-btn', 'click', newSession);
    on('gh-cli-btn', 'click', githubCliConnect);
    on('gh-token', 'keydown', (e) => { if (e.key === 'Enter') githubConnect(); });
    on('gh-token-connect-btn', 'click', githubConnect);
    on('gh-get-token-link', 'click', () => agent.openExternal('https://github.com/settings/tokens'));
    on('gh-disconnect-btn', 'click', githubDisconnect);
    on('gh-load-repos-btn', 'click', () => loadRepos());
    on('repo-search', 'input', (e) => filterRepos(e.target.value));
    on('chat-in', 'input', (e) => autoResize(e.target));
    on('chat-in', 'keydown', chatKey);
    on('send-btn', 'click', sendChat);
    on('auto-toggle', 'click', toggleAuto);
    on('term-in', 'keydown', termKey);
    on('settings-modal', 'click', (e) => { if (e.target === document.getElementById('settings-modal')) closeSettings(); });
    on('settings-close-btn', 'click', closeSettings);
    document.querySelectorAll('.save-key-btn').forEach(btn => btn.addEventListener('click', () => saveKey(btn.dataset.key)));
}

// Browser-only bootstrap (see note above) — skip when there is no `agent`.
if (typeof agent !== 'undefined') (async () => {
    // Restore GitHub session if saved
    const gh = await agent.githubLoadSaved();
    if (gh.ok) {
        setGitHubUser(gh);
    }

    // Auto-connect to database if we have tokens saved
    const conf = await agent.getConfig();
    if (conf.ok && conf.config.SUPABASE_URL && conf.config.SUPABASE_KEY) {
        toggleConnect();
    }
})();
