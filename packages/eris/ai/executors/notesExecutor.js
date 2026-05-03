// ─── Notes Sub-Executor ─────────────────────────────────────────────────────
// Handles: save_note, list_notes, delete_note, search_notes,
//          save_snippet, get_snippet, list_snippets, review_code,
//          set_reminder, list_reminders, cancel_reminder
// Called from main executor.js via delegation.

import * as db from "../../database.js";

const HANDLED = new Set([
  "save_note", "list_notes", "delete_note", "search_notes",
  "save_snippet", "get_snippet", "list_snippets", "review_code",
  "set_reminder", "list_reminders", "cancel_reminder",
]);

function parseTime(timeStr) {
  const match = timeStr.match(/^(\d+)(m|min|h|hr|d|day|w|week)s?$/i);
  if (match) {
    const num = parseInt(match[1]);
    const ms = {
      m: 60000, min: 60000,
      h: 3600000, hr: 3600000,
      d: 86400000, day: 86400000,
      w: 604800000, week: 604800000,
    };
    return new Date(Date.now() + num * (ms[match[2].toLowerCase()] || 60000));
  }
  const parsed = new Date(timeStr);
  return isNaN(parsed.getTime()) ? new Date(Date.now() + 3600000) : parsed;
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "save_note": {
      const title = input.title || "untitled";
      const content = input.content || input.text || input.body || "";
      if (!content) return "no note content provided";
      const ok = await db.saveNote(message.author.id, title, content);
      return ok ? `note saved: "${title}"` : "failed to save note";
    }

    case "list_notes": {
      const notes = await db.getNotes(message.author.id);
      if (!notes.length) return "no notes found";
      return notes.map((n, i) => `${i + 1}. [${n.id}] ${n.title} — ${(n.content || "").slice(0, 60)}`).join("\n");
    }

    case "delete_note": {
      const noteId = input.note_id || input.id;
      if (!noteId) return "no note id provided";
      const ok = await db.deleteNote(message.author.id, noteId);
      return ok ? "note deleted" : "failed to delete note (wrong id or not yours)";
    }

    case "search_notes": {
      const query = input.query || input.search || input.q;
      if (!query) return "no search query provided";
      const results = await db.searchNotes(message.author.id, query);
      if (!results.length) return "no matching notes found";
      return results.map((n, i) => `${i + 1}. [${n.id}] ${n.title} — ${(n.content || "").slice(0, 60)}`).join("\n");
    }

    case "set_reminder": {
      const text = input.text || input.reminder || input.message;
      const timeStr = input.time || input.when || input.in || "1h";
      if (!text) return "no reminder text provided";
      const remindAt = parseTime(timeStr);
      const ok = await db.saveReminder(message.author.id, message.channel.id, text, remindAt.toISOString());
      return ok ? `reminder set for ${remindAt.toLocaleString()}: "${text}"` : "failed to set reminder";
    }

    case "list_reminders": {
      const reminders = await db.getUserReminders(message.author.id);
      if (!reminders.length) return "no pending reminders";
      return reminders.map((r, i) => {
        const when = new Date(r.remind_at).toLocaleString();
        return `${i + 1}. [${r.id}] ${r.reminder_text} — ${when}`;
      }).join("\n");
    }

    case "cancel_reminder": {
      const id = input.reminder_id || input.id;
      if (!id) return "no reminder id provided";
      const ok = await db.cancelReminder(message.author.id, id);
      return ok ? "reminder cancelled" : "failed to cancel reminder (wrong id or not yours)";
    }

    case "review_code": {
      return "code review requested";
    }

    case "save_snippet": {
      const name = input.name || input.title;
      const language = input.language || input.lang || "text";
      const code = input.code || input.content || input.snippet;
      if (!name || !code) return "need both a name and code to save a snippet";
      const ok = await db.saveSnippet(message.author.id, name, language, code);
      return ok ? `snippet saved: "${name}" (${language})` : "failed to save snippet";
    }

    case "get_snippet": {
      const name = input.name || input.title;
      if (!name) return "no snippet name provided";
      const snippet = await db.getSnippet(message.author.id, name);
      if (!snippet) return `no snippet found with name "${name}"`;
      return `\`\`\`${snippet.language || "text"}\n${snippet.code}\n\`\`\``;
    }

    case "list_snippets": {
      const snippets = await db.listSnippets(message.author.id);
      if (!snippets.length) return "no snippets saved";
      return snippets.map((s, i) => `${i + 1}. ${s.name} (${s.language}) — ${new Date(s.created_at).toLocaleDateString()}`).join("\n");
    }

    default:
      return undefined;
  }
}
