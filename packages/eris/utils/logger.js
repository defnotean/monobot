// ─── Logger — pretty console, plain file ───────────────────────────────────
// Thin bot-side shim over `@defnotean/shared/logger`. The shared factory owns
// the redaction, ANSI formatting, and 5 MB rotation logic; this file picks
// the bot-local `bot.log` path and exports `log` + `redact` for callers that
// already do `import { log, redact } from "../utils/logger.js"`.

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "@defnotean/shared/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "bot.log");

const _logger = createLogger({ botPrefix: "ERIS", logFile: LOG_FILE });

export const log = _logger.log;
// Re-export the redactor so callers that want to manually redact a structured
// value (e.g. `log(\`tool: \${name}(\${JSON.stringify(redact(args))})\`)`)
// don't need to reach into @defnotean/shared themselves.
export const redact = _logger.redact;
