import { describe, expect, it, vi } from "vitest";
import {
  compactSignature,
  routeCatalogTool,
  routeRescuedToolCall,
  routerToolDeclaration,
  withRouterTool,
} from "../src/ai/toolRouter.js";

describe("toolRouter", () => {
  it("builds compact signatures with required and optional args", () => {
    const signature = compactSignature({
      name: "send_message",
      description: "Send a message to a channel. This sentence should not appear.",
      input_schema: {
        type: "object",
        properties: {
          channel_id: { type: "string" },
          text: { type: "string" },
          silent: { type: "boolean" },
        },
        required: ["channel_id", "text"],
      },
    });

    expect(signature).toBe("send_message(channel_id:string, text:string, silent?:boolean) - Send a message to a channel.");
  });

  it("includes enum params and truncates long descriptions to a compact line", () => {
    const signature = compactSignature({
      name: "set_mode",
      description: "Configure the mode with a very long explanation that keeps going past the compact signature budget and should be trimmed without losing the argument list.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["on", "off", "auto"] },
        },
        required: ["mode"],
      },
    });

    expect(signature).toContain("set_mode(mode:on|off|auto)");
    expect(signature.length).toBeLessThanOrEqual(200);
  });

  it("adds a router declaration to Gemini and OpenAI tool lists", () => {
    const gemini = withRouterTool([{ functionDeclarations: [{ name: "web_search" }] }], ["scrape_url"], { format: "gemini" });
    expect(gemini[0].functionDeclarations.map((decl: any) => decl.name)).toContain("use_tool");

    const openai = withRouterTool([{ type: "function", function: { name: "web_search" } }], ["scrape_url"], { format: "openai" });
    expect(openai.map((tool: any) => tool.function.name)).toContain("use_tool");
    expect(routerToolDeclaration("openai").function.name).toBe("use_tool");
  });

  it("short-circuits help:true without executing the routed tool", () => {
    const execute = vi.fn();
    const routed = routeCatalogTool("use_tool", {
      tool_name: "scrape_url",
      help: true,
    }, {
      routerToolNames: ["scrape_url"],
      getDeclaration: (name) => name === "scrape_url"
        ? { name, description: "Read a URL.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }
        : null,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(routed.ok).toBe(false);
    expect(routed.result).toContain("scrape_url(url:string)");
  });

  it("executes tier-1 names called through use_tool instead of echoing an error", () => {
    const routed = routeCatalogTool("use_tool", {
      tool_name: "web_search",
      arguments: { query: "cats" },
    }, {
      routerToolNames: ["scrape_url"],
      tier1ToolNames: ["web_search"],
      getDeclaration: (name) => ({ name, description: "Search the web.", input_schema: { type: "object" } }),
    });

    expect(routed).toMatchObject({
      ok: true,
      toolName: "web_search",
      args: { query: "cats" },
      responseName: "use_tool",
    });
  });

  it("echoes a compact signature when a registered tool was not offered this turn", () => {
    const routed = routeCatalogTool("use_tool", { tool_name: "scrape", args: { url: "https://example.com" } }, {
      routerToolNames: [],
      tier1ToolNames: [],
      resolveAlias: (name) => name === "scrape" ? "scrape_url" : name,
      getDeclaration: (name) => name === "scrape_url"
        ? { name, description: "Read a URL.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }
        : null,
    });

    expect(routed.ok).toBe(false);
    expect(routed.result).toContain(`"scrape_url" wasn't offered this turn`);
    expect(routed.result).toContain("scrape_url(url:string)");
  });

  it("rescues router-only hallucinated calls and resolves aliases", () => {
    const rescued = routeRescuedToolCall("scrape", { url: "https://example.com" }, {
      offeredToolNames: ["web_search"],
      routerToolNames: ["scrape_url"],
      resolveAlias: (name: string) => name === "scrape" ? "scrape_url" : name,
    });

    expect(rescued).toEqual({
      name: "use_tool",
      args: { tool_name: "scrape_url", arguments: { url: "https://example.com" } },
    });
  });
});
