// @ts-check
// ─── packages/eris/ai/tools/owner/opsTools.js ────────────────────────────
// Schema-only declarations. Extracted from ../../tools.js — pure data, no logic.
// Handlers live in ai/executor.js / ai/executors/*.

/**
 * @typedef {import("../../tools.js").ToolDef} ToolDef
 */

// ═══════════════════════════════════════════════════════════════════════════
// OWNER TOOLS — EMAIL, GITHUB, DEPLOY, DATABASE & HOST OPS
// Productivity / ops tools: Gmail (read/search/draft/summarize), GitHub
// (repos/issues/PRs/create/stats), deploy status & live watch, database
// queries, system info, process listing, app launch, file browsing.
// ═══════════════════════════════════════════════════════════════════════════
/** @type {ToolDef[]} */
export const OPS_TOOLS = [
  {
    name: "read_emails",
    description:
      "Read recent emails from the configured inbox. Owner-only. Use when the bot owner asks to check email or see what's new in the inbox.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of recent emails to fetch; defaults to 10 if omitted" },
      },
      required: [],
    },
  },
  {
    name: "search_emails",
    description:
      "Search the email inbox by query string. Owner-only. Use when the bot owner wants to find a specific email by sender, subject, or keyword.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to match against email subjects, senders, and bodies" },
        count: { type: "number", description: "Max number of results to return; defaults to 10 if omitted" },
      },
      required: ["query"],
    },
  },
  {
    name: "draft_email",
    description:
      "Compose and save an email draft (does not send). Owner-only. Use when the bot owner asks to write or prepare an email for review before sending.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body content (plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "summarize_inbox",
    description:
      "Generate a summary of the current inbox state: unread count, important threads, and action items. Owner-only. Use when the bot owner wants a quick overview without reading every email.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "github_repos",
    description:
      "List or search GitHub repositories. Owner-only. Use when the bot owner asks about their repos, wants to find a project, or needs an overview of what's on GitHub.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query to filter repos by name or description" },
      },
      required: [],
    },
  },
  {
    name: "github_issues",
    description:
      "List open issues for a GitHub repository. Owner-only. Use when the bot owner asks about bugs, feature requests, or tasks on a repo.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format (e.g. 'octocat/hello-world')" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_prs",
    description:
      "List open pull requests for a GitHub repository. Owner-only. Use when the bot owner asks about PRs, pending reviews, or merge status.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_create_issue",
    description:
      "Create a new issue on a GitHub repository. Owner-only. Use when the bot owner wants to file a bug, feature request, or task directly from Discord.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
        title: { type: "string", description: "GitHub issue title" },
        body: { type: "string", description: "Issue body/description in Markdown" },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "github_repo_stats",
    description:
      "Get statistics for a GitHub repository: stars, forks, open issues, languages, recent activity. Owner-only. Use when the bot owner wants a quick health check or overview of a repo.",
    input_schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository in 'owner/repo' format" },
      },
      required: ["repo"],
    },
  },
  {
    name: "check_deploy",
    description:
      "Check the deployment status of a service. Owner-only. Use when the bot owner asks if something is deployed, running, or wants to verify a deploy went through.",
    input_schema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Name of the service to check; omit to check all services" },
      },
      required: [],
    },
  },
  {
    name: "watch_deploy",
    description:
      "Watch a deployment in progress and report status changes. Owner-only. Use when the bot owner kicks off a deploy and wants live updates on its progress.",
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Name of the service being deployed" },
        project_id: { type: "string", description: "Project or deployment ID to monitor" },
      },
      required: ["service", "project_id"],
    },
  },
  {
    name: "query_database",
    description:
      "Run a read query against the project database. Owner-only. Use when the bot owner needs to look up data, check records, or inspect database contents.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "The database table to query" },
        select: { type: "string", description: "Comma-separated column names to select; defaults to all columns" },
        filter: { type: "string", description: "Column name to filter on" },
        filter_value: { type: "string", description: "Value to match for the filter column" },
        limit: { type: "number", description: "Max number of rows to return" },
      },
      required: ["table"],
    },
  },
  {
    name: "list_tables",
    description:
      "List all tables in the project database. Owner-only. Use when the bot owner wants to see what data is available or explore the database schema.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "system_info",
    description:
      "Get system information: CPU, memory, disk, uptime, OS details. Owner-only. Use when the bot owner asks about server health, resource usage, or system status.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_processes",
    description:
      "List running processes on the host, optionally filtered by name. Owner-only. Use when the bot owner wants to see what's running, check if a process is alive, or debug resource usage.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter processes by name substring (e.g. 'node', 'python')" },
      },
      required: [],
    },
  },
  {
    name: "launch_app",
    description:
      "Launch a desktop application by name on the host machine — Chrome, Notepad, Spotify, Discord, etc. Owner-only. ALWAYS prefer this over execute_terminal for opening apps: 'open chrome', 'launch spotify', 'start notepad', 'run discord' all map to launch_app. execute_terminal is for shell commands (ls, git, docker), NOT for opening user-facing apps.",
    input_schema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Application name or path to executable (e.g. 'chrome', 'notepad', 'C:/Program Files/X/x.exe')" },
        args: { type: "string", description: "Optional command-line arguments to pass to the application" },
      },
      required: ["app"],
    },
  },
  {
    name: "browse_files",
    description:
      "Browse and list files in a directory on the host machine. Owner-only. Use when the bot owner wants to explore the file system, find files, or check what's in a folder.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the directory to browse" },
      },
      required: ["path"],
    },
  },
];
