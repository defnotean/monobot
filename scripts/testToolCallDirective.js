#!/usr/bin/env node
// Live integration test for TOOL_CALL_DIRECTIVE.
//
// Hits OpenRouter directly with the actual directive + a minimal tool spec
// and asserts the model emits a structured tool_calls field instead of
// hallucinating "ok i did it" prose without a real call.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/testToolCallDirective.js [iterations]
//
// Defaults: 5 iterations against `openai/gpt-oss-120b:free`. Override with
//   OPENROUTER_MODEL=anthropic/claude-sonnet-4.5 ITERATIONS=10
//
// Pass criteria: every iteration must (a) emit a real `tool_calls` field
// referencing set_create_vc_channel and (b) NOT contain a text-shaped
// "[tool call: ..." leak in the visible content.

import process from "node:process";

const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_COMPAT_API_KEY;
if (!apiKey) {
  console.error("Need OPENROUTER_API_KEY (or OPENAI_COMPAT_API_KEY) in env.");
  process.exit(2);
}

const model = process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
const iterations = parseInt(process.argv[2] || process.env.ITERATIONS || "5", 10);

// Mirror the actual directive verbatim. Update if TOOL_CALL_DIRECTIVE in
// packages/{eris,irene}/events/messageCreate.js changes.
const TOOL_CALL_DIRECTIVE = `
CRITICAL — TOOL CALL PROTOCOL (read before every reply):
- To take an action, you MUST emit a real structured tool call (the API's tool_calls field). The runtime executes ONLY structured calls — never text descriptions of calls.
- NEVER write tool calls as visible text content. The following are FORBIDDEN in your reply text and will silently fail to run anything:
    [tool call: name] {...}
    [function call: name] {...}
    <tool_call>...</tool_call>
    print(name(...))
    name({...})
- If you write any of those as text instead of using the structured tool field, NO ACTION HAPPENS — you'll be lying to the user about what you did.
- Do NOT confirm an action ("ok set that vc as the trigger", "done", "marked", "saved") unless you actually emitted a structured tool call THIS turn. If you didn't make a real call, say so plainly: "i tried but the tool call didn't go through, retry?".
- Don't describe a tool call in prose ("I'll call set_create_vc_channel...") — just emit the structured call. The user sees the result either way.
- After a structured tool call returns successfully, your visible reply should be a short natural-language confirmation only — no tool syntax of any kind in the reply text.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "set_create_vc_channel",
      description: "Designate an EXISTING voice channel as the create-VC trigger. When users join it they get their own personal VC. Use when an admin says 'set this as a create-vc', 'turn this vc into a creator', etc.",
      parameters: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Discord voice channel ID" },
          channel_name: { type: "string", description: "Voice channel name" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_event_channels",
      description: "Manage which channels server events can fire in. Action 'deny' blocks channels.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "add", "remove", "clear", "list", "deny", "undeny", "clear_denied"] },
          channels: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
];

const PROMPTS = [
  "Irene set this into a create a vc 1489058216703950939",
  "set channel 1234567890123456789 as the create-vc trigger",
  "turn off events in channel 5555555555555555555",
  "block events from channel 9876543210987654321",
  "make 1489058216703950939 the join-to-create channel",
];

async function callOpenRouter(systemInstruction, userMessage) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],
      tools: TOOLS,
      tool_choice: "auto",
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const TEXT_LEAK_RE = /\[tool[\s_-]?call:|\[function[\s_-]?call:|<tool_call>|<function_call>/i;

function inspect(data, prompt) {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const toolCalls = msg?.tool_calls || [];
  const content = String(msg?.content || "");
  const finishReason = choice?.finish_reason;
  const hasStructured = Array.isArray(toolCalls) && toolCalls.length > 0;
  const hasTextLeak = TEXT_LEAK_RE.test(content);
  const looksLikeFakeConfirm = !hasStructured && /\b(ok|done|set|marked|saved|configured|disabled|turned off)\b/i.test(content) && content.length < 300;
  return { hasStructured, hasTextLeak, looksLikeFakeConfirm, toolCalls, content, finishReason };
}

console.log(`[live test] model=${model} iterations=${iterations}`);
console.log(`[live test] directive length: ${TOOL_CALL_DIRECTIVE.length} chars\n`);

let pass = 0;
let textLeakHits = 0;
let fakeConfirmHits = 0;
let networkErrors = 0;

for (let i = 0; i < iterations; i++) {
  const prompt = PROMPTS[i % PROMPTS.length];
  process.stdout.write(`[${i + 1}/${iterations}] prompt: "${prompt.slice(0, 60)}" → `);
  try {
    const data = await callOpenRouter(TOOL_CALL_DIRECTIVE, prompt);
    const r = inspect(data, prompt);
    if (r.hasStructured && !r.hasTextLeak) {
      pass++;
      const names = r.toolCalls.map((c) => c.function?.name).join(", ");
      console.log(`PASS — structured tool_calls: ${names}`);
    } else {
      console.log(`FAIL`);
      if (r.hasTextLeak) {
        textLeakHits++;
        console.log(`  text-leak in content: ${r.content.slice(0, 150).replace(/\n/g, " ")}`);
      }
      if (r.looksLikeFakeConfirm) {
        fakeConfirmHits++;
        console.log(`  fake-confirm (no structured call but claims completion): "${r.content.slice(0, 150)}"`);
      }
      if (!r.hasStructured && !r.hasTextLeak && !r.looksLikeFakeConfirm) {
        console.log(`  no tool call, no leak, content: "${r.content.slice(0, 150).replace(/\n/g, " ")}" (finish=${r.finishReason})`);
      }
    }
  } catch (err) {
    networkErrors++;
    console.log(`NETWORK ERROR: ${err.message}`);
  }
}

console.log(`\n=== RESULT ===`);
console.log(`pass:           ${pass}/${iterations}`);
console.log(`text leaks:     ${textLeakHits}`);
console.log(`fake confirms:  ${fakeConfirmHits}`);
console.log(`network errors: ${networkErrors}`);

if (pass === iterations) {
  console.log(`\nALL PASS — directive is reliably forcing structured tool_calls on this model.`);
  process.exit(0);
}
console.log(`\nSOME FAIL — directive isn't enough for ${model}. Either strengthen it further or switch model.`);
process.exit(1);
