// @ts-check
// ─── packages/eris/ai/tools/everyone/notesReminders.js ───────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// EVERYONE TOOLS — NOTES, REMINDERS & CODE HELPERS
// Per-user named notes (CRUD + search), timed reminders (set/list/cancel),
// code review and saved code snippets (named scratchpad).
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const NOTES_REMINDER_TOOLS = [
  {
    name: "save_note",
    description:
      "Save a note with a title and content for later retrieval. Use when someone wants to jot something down, save a message, bookmark an idea, or store any text for future reference.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title or label for the note" },
        content: { type: "string", description: "The full note content to save" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_notes",
    description:
      "List all saved notes. Use when someone wants to see what notes exist or browse their saved items.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_note",
    description:
      "Delete a saved note by its ID. Use when someone wants to remove a note they no longer need.",
    input_schema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "The unique ID of the note to delete" },
      },
      required: ["note_id"],
    },
  },
  {
    name: "search_notes",
    description:
      "Search through saved notes by keyword or phrase. Use when someone is looking for a specific note but doesn't know the exact title or ID.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to match against note titles and content" },
      },
      required: ["query"],
    },
  },
  {
    name: "set_reminder",
    description:
      "Set a timed reminder that will ping the user after a delay. Use when someone says 'remind me in...', wants a timer, or needs to be notified about something later. Do NOT use for DISBOARD bump reminders — for those use configure_bump_reminder.",
    input_schema: {
      type: "object",
      properties: {
        reminder_text: { type: "string", description: "What to remind the user about" },
        time: {
          type: "string",
          description: "How long from now to trigger the reminder, e.g. '30m', '2h', '1d'",
        },
      },
      required: ["reminder_text", "time"],
    },
  },
  {
    name: "list_reminders",
    description:
      "List all active (pending) reminders, optionally filtered to a specific user. Use when someone wants to see what reminders are set.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Filter reminders to this Discord user ID; omit for all" },
      },
      required: [],
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel a pending reminder by its ID. Use when someone no longer needs a reminder they set earlier.",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: { type: "string", description: "The unique ID of the reminder to cancel" },
      },
      required: ["reminder_id"],
    },
  },
  {
    name: "review_code",
    description:
      "Review a code snippet for bugs, style issues, and improvements. Use when someone pastes code and asks for feedback, a review, or help debugging.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The source code to review" },
        language: { type: "string", description: "Programming language of the code (e.g. 'javascript', 'python'); auto-detected if omitted" },
      },
      required: ["code"],
    },
  },
  {
    name: "save_snippet",
    description:
      "Save a named code snippet for later reuse. Use when someone wants to store a piece of code they might need again, like a utility function or config template.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short, unique name to identify the snippet" },
        code: { type: "string", description: "The source code to save" },
        language: { type: "string", description: "Programming language of the snippet" },
      },
      required: ["name", "code"],
    },
  },
  {
    name: "get_snippet",
    description:
      "Retrieve a previously saved code snippet by name. Use when someone asks to recall or paste a snippet they saved earlier.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the snippet to retrieve" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_snippets",
    description:
      "List all saved code snippets. Use when someone wants to see what snippets are available.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
