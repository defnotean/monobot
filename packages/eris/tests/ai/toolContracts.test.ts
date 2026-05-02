import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// @ts-expect-error JS module without types
import { EVERYONE_TOOLS, OWNER_TOOLS } from "../../ai/tools.js";

type Tool = {
  name: string;
  description?: string;
  input_schema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
};

const tools = [...EVERYONE_TOOLS, ...OWNER_TOOLS] as Tool[];

function tool(name: string) {
  const found = tools.find((t) => t.name === name);
  expect(found, `missing tool ${name}`).toBeTruthy();
  return found!;
}

async function listJsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  }));
  return files.flat();
}

async function collectHandledToolNames() {
  const names = new Set<string>();
  for (const file of await listJsFiles(join(process.cwd(), "ai"))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/case\s+["']([a-z][a-z0-9_]*)["']/g)) names.add(match[1]);
    for (const match of source.matchAll(/toolName\s*={2,3}\s*["']([a-z][a-z0-9_]*)["']/g)) names.add(match[1]);
    for (const match of source.matchAll(/HANDLED\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
      for (const item of match[1].matchAll(/["']([a-z][a-z0-9_]*)["']/g)) names.add(item[1]);
    }
  }
  return names;
}

function parseObjectValues(source: string, objectName: string) {
  const start = source.indexOf(`const ${objectName} = {`);
  if (start < 0) return [];
  const end = source.indexOf("\n};", start);
  return [...source.slice(start, end).matchAll(/:\s*["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]);
}

function parseSetValues(source: string, setName: string) {
  const match = source.match(new RegExp(`const\\s+${setName}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`));
  if (!match) return [];
  return [...match[1].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((item) => item[1]);
}

function expectRequiredPropertiesAreDocumented(t: Tool) {
  const schema = t.input_schema;
  expect(schema?.type, `${t.name} schema type`).toBe("object");
  expect(schema?.properties, `${t.name} properties`).toBeTruthy();
  for (const key of schema?.required || []) {
    const prop = schema?.properties?.[key];
    expect(prop, `${t.name} required property ${key} must exist`).toBeTruthy();
    expect(String(prop?.description || "").trim().length, `${t.name}.${key} needs a clear description`).toBeGreaterThanOrEqual(12);
  }
}

describe("Eris tool contracts", () => {
  it("keeps every exposed tool unique, documented, and executable", async () => {
    const names = new Set<string>();
    const handled = await collectHandledToolNames();

    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(names.has(t.name), `duplicate tool ${t.name}`).toBe(false);
      names.add(t.name);
      expect(String(t.description || "").trim().length, `${t.name} needs a clear description`).toBeGreaterThanOrEqual(25);
      expectRequiredPropertiesAreDocumented(t);
      expect(handled.has(t.name), `${t.name} has a schema but no executor handler`).toBe(true);
    }
  });

  it("keeps aliases and cache policy pointed at real tools", async () => {
    const names = new Set(tools.map((t) => t.name));
    const executor = await readFile(join(process.cwd(), "ai", "executor.js"), "utf8");
    const refs = [
      ...parseObjectValues(executor, "TOOL_ALIASES"),
      ...parseSetValues(executor, "CACHEABLE_TOOLS"),
      ...parseSetValues(executor, "CACHE_INVALIDATING_TOOLS"),
    ];

    for (const ref of refs) {
      expect(names.has(ref), `${ref} is referenced by aliases/cache but is not an exposed tool`).toBe(true);
    }
  });

  it("documents high-risk lookalike tool families with explicit boundaries", () => {
    expect(tool("update_personality").description).toMatch(/Update Eris/i);
    expect(tool("update_personality").description).not.toMatch(/Update Irene/i);
    expect(tool("ask_irene").description).toMatch(/Irene/i);

    expect(tool("execute_terminal").description).toMatch(/one-off shell command/i);
    expect(tool("execute_terminal").description).toMatch(/execute_local/i);
    expect(tool("execute_local").description).toMatch(/audit/i);
    expect(tool("execute_local").description).toMatch(/execute_terminal/i);

    expect(tool("set_event_channels").description).toMatch(/events/i);
    expect(tool("set_event_channels").description).toMatch(/set_chat_channels/i);
    expect(tool("set_chat_channels").description).toMatch(/normal chat/i);
    expect(tool("set_chat_channels").description).toMatch(/set_event_channels/i);

    expect(tool("configure_feature").description).toMatch(/server-level features/i);
    expect(tool("configure_feature").description).toMatch(/configure_game/i);
    expect(tool("configure_game").description).toMatch(/odds, payouts/i);
    expect(tool("configure_game").description).toMatch(/configure_feature/i);
    expect(tool("configure_slots").description).toMatch(/slot machine symbol table/i);
  });
});
