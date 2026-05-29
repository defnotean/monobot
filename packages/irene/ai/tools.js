// @ts-check
// ─── packages/irene/ai/tools.js ─────────────────────────────────────────
// Public facade for Irene's tool schemas. Keep imports here stable so callers
// do not care how the schema groups are split internally.

import { ADMIN_TOOLS } from "./tools/adminTools.js";
import { EVERYONE_TOOLS } from "./tools/everyoneTools.js";
import { registerPresenceBotTools } from "./toolRegistry.js";

registerPresenceBotTools(ADMIN_TOOLS, EVERYONE_TOOLS);

export { ADMIN_TOOLS, EVERYONE_TOOLS };
