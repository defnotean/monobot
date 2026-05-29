import { describe, expect, it } from "vitest";
import { applyPromptBudget, PROMPT_BUDGET } from "../../events/messageCreate/aiInvoke.js";

// Regression: Irene's contextBuild emits a "\n\n[Currently speaking:"
// runtime-boundary anchor (matching Eris). applyPromptBudget locates that
// anchor to split CORE (huge static personality/capability doc) from RUNTIME
// (per-turn memory/mood/directives/server-rules + the Tier-2 tool catalog)
// and trims CORE while preserving RUNTIME. Previously the anchor never
// appeared at a line start, so the budgeter fell back to a hard slice that
// chopped runtime — and with it the Tier-2 catalog — off the END, making
// those tools unreachable. These tests pin the fixed behavior and document
// the bug.
//
// CRITICAL — these tests now exercise the PRODUCTION regime. The real Irene
// admin catalog is ~15.6k chars (194 tool lines) — LARGER than the entire
// 12000-char PROMPT_BUDGET by itself. A toy 3-tool catalog (~180 chars) never
// pushes runtime over the budget, so the failing code path (the final hard
// slice at aiInvoke.js when runtime alone exceeds the budget) is never hit and
// a passing test gives false confidence. We therefore build a realistically
// oversized catalog so the hard-slice path actually fires.

// PROMPT_BUDGET is imported from the source so this test is correct at ANY
// configured budget (12k cloud / 100k local). Fixtures are sized RELATIVE to
// it so the catalog alone exceeds the budget and the core forces trimming.

// Build a catalog whose total size exceeds the budget (each "- name: desc"
// line is ~60-80 chars), mirroring the real admin catalog being larger than
// the budget by itself.
function buildBigCatalog(): { catalog: string; names: string[] } {
  const names: string[] = [];
  const lines: string[] = [];
  const toolCount = Math.ceil(PROMPT_BUDGET / 60) + 50;
  for (let i = 0; i < toolCount; i++) {
    const name = `tier2_tool_${String(i).padStart(4, "0")}`;
    names.push(name);
    lines.push(`- ${name}: does a representative administrative thing number ${i}`);
  }
  const catalog =
    "\n\nOTHER AVAILABLE TOOLS (you can call these by name — just use the tool name and provide the required arguments):\n" +
    lines.join("\n");
  return { catalog, names };
}

const { catalog: BIG_CATALOG, names: CATALOG_NAMES } = buildBigCatalog();

// Oversized static core (> the budget) so trimming must engage.
const BIG_CORE = "STATIC_CAPABILITY_DOC_LINE ".repeat(Math.ceil(PROMPT_BUDGET / 27) + 200);

// The fixed prompt shape: anchor + memory + DIRECTIVES + SERVER RULES, with the
// catalog appended LAST (after the behavioral rules) — mirroring contextBuild.
const ANCHOR = "\n\n[Currently speaking: bob (ID: 1)]";
const MEMORY = "\n[you're feeling good right now]";
const DIRECTIVES =
  "\n\n[DIRECTIVES — rules you MUST follow in this server. these were set by admins and override your default behavior:\n- always greet new members warmly\n- never delete #general]";
const RULES =
  "\n\n[SERVER RULES — the official rules of this server:\n1. [high] no spam\n2. [low] be kind]";

describe("applyPromptBudget runtime anchor (Irene)", () => {
  // Sanity: the catalog alone must exceed the budget, otherwise this whole
  // suite would not exercise the hard-slice regime that bit production.
  it("uses a realistically oversized catalog (catalog alone exceeds the budget)", () => {
    expect(BIG_CATALOG.length).toBeGreaterThan(PROMPT_BUDGET);
  });

  // The behavioral-rule regression fix: with the catalog appended LAST (after
  // DIRECTIVES + SERVER RULES), the in-place budget hard-slice chops the
  // CATALOG tail rather than the admin-set DIRECTIVES / SERVER RULES. Those
  // behavioral rules — which override Irene's defaults — must always survive.
  it("preserves DIRECTIVES and SERVER RULES when the catalog is appended LAST", () => {
    const runtime = ANCHOR + MEMORY + DIRECTIVES + RULES + BIG_CATALOG;
    const out = applyPromptBudget(BIG_CORE + runtime);

    expect(out.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    expect(out).toContain("Currently speaking: bob");
    // Admin behavioral rules survive — they precede the catalog now.
    expect(out).toContain("never delete #general");
    expect(out).toContain("no spam");
    // Core got trimmed — it cannot have survived in full.
    expect(out.includes(BIG_CORE)).toBe(false);
  });

  // Documents the BUG the fix targets: appending the oversized catalog INSIDE
  // the budgeted region (the old contextBuild line-485 position, BEFORE
  // directives/rules) makes applyPromptBudget's final hard slice drop BOTH a
  // large chunk of the catalog AND the trailing DIRECTIVES / SERVER RULES.
  // This is the production failure on every budget-pressured admin turn.
  it("DROPS directives/rules and ~half the catalog when the catalog sits INSIDE the budget before them (documents the bug)", () => {
    const runtime = ANCHOR + MEMORY + BIG_CATALOG + DIRECTIVES + RULES;
    const out = applyPromptBudget(BIG_CORE + runtime);

    expect(out.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    // Behavioral rules that follow the oversized catalog are sliced off.
    expect(out).not.toContain("never delete #general");
    expect(out).not.toContain("no spam");
    // And the catalog itself is only partially present — many tools vanish
    // from BOTH tier-1 and the surviving catalog text = unreachable.
    const survived = CATALOG_NAMES.filter((n) => out.includes(n)).length;
    expect(survived).toBeLessThan(CATALOG_NAMES.length);
  });

  // The FULLY-correct fix: the catalog is EXCLUDED from the budgeted string and
  // appended AFTER applyPromptBudget (mirroring Eris's contextBuild, which
  // appends post-budget). Every catalog tool then survives — the completeness
  // invariant holds at runtime. This is the contract contextBuild now supports
  // by returning `tier2Catalog` separately for the orchestrator to append
  // post-budget. (See needsInfra: messageCreate.js must wire this up.)
  it("preserves the ENTIRE catalog when it is appended AFTER applyPromptBudget", () => {
    const runtime = ANCHOR + MEMORY + DIRECTIVES + RULES;
    let out = applyPromptBudget(BIG_CORE + runtime);
    // Behavioral rules survived the budget (they're the only runtime now).
    expect(out).toContain("never delete #general");
    expect(out).toContain("no spam");
    // Catalog appended post-budget — NOT subject to the 12000 cap.
    out += BIG_CATALOG;
    for (const name of CATALOG_NAMES) expect(out).toContain(name);
  });
});
