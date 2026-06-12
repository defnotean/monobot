const ROUTER_DESCRIPTION = "Call a catalog-only tool by exact name. Use only for tools listed in OTHER AVAILABLE TOOLS.";

/**
 * @typedef {{ ok: true, toolName: string, args: Record<string, any>, responseName: string }} RoutedToolOk
 * @typedef {{ ok: false, responseName: string, result: string }} RoutedToolError
 * @typedef {RoutedToolOk | RoutedToolError} RoutedToolResult
 * @typedef {{ name: string, args: Record<string, any> }} RescuedToolCall
 * @typedef {{
 *   routerToolNames?: string[],
 *   tier1ToolNames?: string[],
 *   resolveAlias?: (name: string) => string,
 *   getDeclaration?: (name: string) => any
 * }} RouterOptions
 * @typedef {{
 *   offeredToolNames?: string[],
 *   routerToolNames?: string[],
 *   tier1ToolNames?: string[],
 *   resolveAlias?: (name: string) => string,
 *   getDeclaration?: (name: string) => any
 * }} RescueOptions
 */

/**
 * @param {any} toolDecl
 * @returns {Record<string, any>}
 */
function schemaOf(toolDecl) {
  return toolDecl?.input_schema || toolDecl?.parameters || { type: "object", properties: {} };
}

/**
 * @param {any} prop
 * @returns {string}
 */
function typeOf(prop) {
  if (!prop || typeof prop !== "object") return "any";
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum.map(String).join("|");
  if (Array.isArray(prop.type)) return prop.type.map(String).join("|");
  return String(prop.type || "any");
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const raw = String(text || "No description").replace(/\s+/g, " ").trim();
  const match = raw.match(/^.*?(?:[.!?](?:\s|$)|$)/);
  return (match?.[0] || raw).trim();
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function trimTo(text, max) {
  const raw = String(text || "");
  if (raw.length <= max) return raw;
  const slice = raw.slice(0, max - 1);
  const cut = slice.replace(/\s+\S*$/, "");
  return `${cut || slice}...`;
}

/**
 * Build a one-line compact signature: name(arg:type, arg?:type) - sentence.
 * @param {any} toolDecl
 * @returns {string}
 */
export function compactSignature(toolDecl) {
  const name = String(toolDecl?.name || toolDecl?.function?.name || "unknown_tool");
  const schema = schemaOf(toolDecl?.function ? toolDecl.function : toolDecl);
  /** @type {Record<string, any>} */
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  const args = Object.entries(properties).map(([argName, prop]) => {
    const optional = required.has(argName) ? "" : "?";
    return `${argName}${optional}:${typeOf(prop)}`;
  });
  const desc = firstSentence(toolDecl?.description || toolDecl?.function?.description || "");
  return trimTo(`${name}(${args.join(", ")}) - ${desc}`, 200);
}

/**
 * @param {"gemini"|"openai"} [format]
 * @returns {any}
 */
export function routerToolDeclaration(format = "gemini") {
  const declaration = {
    name: "use_tool",
    description: ROUTER_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact catalog tool name to call." },
        arguments: { type: "object", description: "Arguments for that tool." },
        help: { type: "boolean", description: "Return this tool's compact signature without executing it." },
      },
      required: ["tool_name"],
    },
  };
  if (format === "openai") {
    return { type: "function", function: declaration };
  }
  return declaration;
}

/**
 * @param {any[]|undefined} tools
 * @param {string[]} [routerToolNames]
 * @param {{ format?: "gemini"|"openai" }} [options]
 * @returns {any[]|undefined}
 */
export function withRouterTool(tools, routerToolNames = [], { format = "gemini" } = {}) {
  if (!Array.isArray(routerToolNames) || routerToolNames.length === 0) return tools;
  const router = routerToolDeclaration(format);
  if (format === "openai") {
    return [...(tools || []), router];
  }
  if (!tools?.length) return [{ functionDeclarations: [router] }];
  return tools.map((group, idx) => ({
    ...group,
    functionDeclarations: idx === 0
      ? [...(group.functionDeclarations || []), router]
      : group.functionDeclarations,
  }));
}

/**
 * @param {string} name
 * @param {any} decl
 * @returns {string}
 */
function echoMiss(name, decl) {
  return `"${name}" wasn't offered this turn. Signature: ${compactSignature(decl)} - call it directly as a tool (not via use_tool) if it has a schema this turn, otherwise retry use_tool with exactly this name.`;
}

/**
 * Route a normal tool or the `use_tool` router.
 * @param {string} name
 * @param {any} args
 * @param {object} [opts]
 * @param {string[]} [opts.routerToolNames]
 * @param {string[]} [opts.tier1ToolNames]
 * @param {(name: string) => string} [opts.resolveAlias]
 * @param {(name: string) => any} [opts.getDeclaration]
 * @returns {RoutedToolResult}
 */
export function routeCatalogTool(name, args, opts = {}) {
  if (name !== "use_tool") return { ok: true, toolName: name, args: args || {}, responseName: name };

  /** @type {RouterOptions} */
  const routerOptions = opts;
  const {
    routerToolNames = [],
    tier1ToolNames = [],
    resolveAlias = /** @param {string} toolName */ (toolName) => toolName,
    getDeclaration = () => null,
  } = routerOptions;
  const raw = args || {};
  const rawToolName = String(raw.tool_name || raw.name || raw.tool || "").trim();
  if (!rawToolName) return { ok: false, responseName: "use_tool", result: "Error: use_tool requires tool_name" };

  const toolName = String(resolveAlias(rawToolName) || rawToolName).trim();
  const allowed = new Set(routerToolNames || []);
  const tier1 = new Set(tier1ToolNames || []);
  const decl = getDeclaration(toolName);

  if (raw.help === true || raw.args?.help === true || raw.arguments?.help === true) {
    if (decl) return { ok: false, responseName: "use_tool", result: compactSignature(decl) };
    return { ok: false, responseName: "use_tool", result: `Error: "${toolName}" is not available in this turn's catalog` };
  }

  const routedArgs = raw.arguments ?? raw.args ?? raw.input ?? raw.parameters ?? {};
  const finalArgs = routedArgs && typeof routedArgs === "object" ? routedArgs : {};
  if (allowed.has(toolName) || tier1.has(toolName)) {
    return { ok: true, toolName, args: finalArgs, responseName: "use_tool" };
  }

  if (decl) return { ok: false, responseName: "use_tool", result: echoMiss(toolName, decl) };
  return { ok: false, responseName: "use_tool", result: `Error: "${toolName}" is not available in this turn's catalog` };
}

/**
 * Convert a JSON-in-text hallucinated call into a real provider tool call.
 * Directly offered tools stay direct; router-only/tier-2 tools are wrapped in
 * `use_tool` so the normal catalog router validates and executes them later.
 * @param {string} name
 * @param {any} args
 * @param {object} [opts]
 * @param {string[]} [opts.offeredToolNames]
 * @param {string[]} [opts.routerToolNames]
 * @param {string[]} [opts.tier1ToolNames]
 * @param {(name: string) => string} [opts.resolveAlias]
 * @param {(name: string) => any} [opts.getDeclaration]
 * @returns {RescuedToolCall|null}
 */
export function routeRescuedToolCall(name, args, opts = {}) {
  const rawName = String(name || "").trim();
  if (!rawName) return null;

  /** @type {RescueOptions} */
  const rescueOptions = opts;
  const {
    offeredToolNames = [],
    resolveAlias = /** @param {string} toolName */ (toolName) => toolName,
  } = rescueOptions;
  const finalArgs = args && typeof args === "object" ? args : {};
  const canonicalName = String(resolveAlias(rawName) || rawName).trim();
  const offered = new Set(offeredToolNames || []);
  if (offered.has(canonicalName)) return { name: canonicalName, args: finalArgs };

  const routed = routeCatalogTool("use_tool", { tool_name: rawName, arguments: finalArgs }, opts);
  if (!routed.ok) return null;
  return {
    name: "use_tool",
    args: { tool_name: routed.toolName, arguments: routed.args },
  };
}
