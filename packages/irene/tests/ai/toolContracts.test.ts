import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// @ts-expect-error JS module without types
import { ADMIN_TOOLS, EVERYONE_TOOLS } from "../../ai/tools.js";

type Tool = {
  name: string;
  description?: string;
  input_schema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
};

const tools = [...ADMIN_TOOLS, ...EVERYONE_TOOLS] as Tool[];

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

describe("Irene tool contracts", () => {
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
    expect(tool("create_channel").description).toMatch(/brand-new/i);
    expect(tool("create_channel").description).toMatch(/set_create_vc_channel/i);
    expect(tool("set_create_vc_channel").description).toMatch(/existing voice channel/i);
    expect(tool("set_vc_template").description).toMatch(/do not use.*trigger channel/i);
    expect(tool("set_afk_channel").description).toMatch(/do not use.*join-to-create/i);

    expect(tool("set_server_icon").description).toMatch(/discord server icon/i);
    expect(tool("set_server_avatar").description).toMatch(/bot's profile picture/i);

    expect(tool("react_to_message").description).toMatch(/plain emoji reaction/i);
    expect(tool("remove_reaction").description).toMatch(/plain emoji reaction/i);
    expect(tool("remove_reaction_role").description).toMatch(/reaction-role mapping/i);
    expect(tool("remove_reaction_role").description).toMatch(/remove_reaction/i);

    expect(tool("set_dm_preference").description).toMatch(/don't want DMs/i);
    expect(tool("set_dm_results").description).toMatch(/tool\/command results/i);
    expect(tool("set_dm_welcome").description).toMatch(/welcome message/i);
  });
});
