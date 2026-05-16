// ─── GitHub Sub-Executor ────────────────────────────────────────────────────
// Handles: github_repos, github_issues, github_prs, github_create_issue,
//          github_repo_stats, check_deploy, watch_deploy,
//          read_emails, search_emails, draft_email, summarize_inbox
// Owner-only tools. Called from main executor.js via delegation.

import config from "../../config.js";
import { isOwner, denyMessage } from "../../utils/permissions.js";
import * as db from "../../database.js";

const HANDLED = new Set([
  "github_repos", "github_issues", "github_prs", "github_create_issue",
  "github_repo_stats", "check_deploy", "watch_deploy",
  "read_emails", "search_emails", "draft_email", "summarize_inbox",
]);

// ─── Lazy singletons ────────────────────────────────────────────────────────

let _gmail = null;
async function getGmail() {
  if (_gmail) return _gmail;
  if (!config.google.enabled) return null;
  const { google } = await import("googleapis");
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  oauth2.setCredentials({ refresh_token: config.google.refreshToken });
  _gmail = google.gmail({ version: "v1", auth: oauth2 });
  return _gmail;
}

let _octokit = null;
async function getOctokit() {
  if (_octokit) return _octokit;
  if (!config.githubToken) return null;
  const { Octokit } = await import("@octokit/rest");
  _octokit = new Octokit({ auth: config.githubToken });
  return _octokit;
}

// Schema documents `repo: "owner/repo"` as a single string; legacy callers
// (and Gemini sometimes) supply `owner` + `repo` separately. Accept both.
function resolveRepo(input) {
  const raw = input.repo || "";
  if (raw.includes("/")) {
    const [owner, repoPart] = raw.split("/", 2);
    return { owner: input.owner || input.org || owner, repo: repoPart };
  }
  return { owner: input.owner || input.org, repo: raw };
}

export async function execute(toolName, input, message, _context) {
  if (!HANDLED.has(toolName)) return undefined;

  switch (toolName) {

    case "read_emails": {
      if (!isOwner(message.author.id)) return denyMessage();
      const gmail = await getGmail();
      if (!gmail) return "gmail not configured";
      try {
        const maxResults = input.count || input.max || input.limit || 10;
        const { data } = await gmail.users.messages.list({ userId: "me", maxResults, q: input.filter || "" });
        if (!data.messages?.length) return "no emails found";
        const emails = [];
        for (const msg of data.messages.slice(0, 10)) {
          const { data: full } = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
          const headers = full.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "unknown";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          const date = headers.find(h => h.name === "Date")?.value || "";
          emails.push(`- ${subject}\n  from: ${from}\n  date: ${date}`);
        }
        return emails.join("\n");
      } catch (e) {
        return `email read failed: ${e.message}`;
      }
    }

    case "search_emails": {
      if (!isOwner(message.author.id)) return denyMessage();
      const gmail = await getGmail();
      if (!gmail) return "gmail not configured";
      try {
        const query = input.query || input.search || input.q;
        if (!query) return "no search query provided";
        const maxResults = input.count || input.max || input.limit || 10;
        const { data } = await gmail.users.messages.list({ userId: "me", maxResults, q: query });
        if (!data.messages?.length) return "no emails matched";
        const results = [];
        for (const msg of data.messages.slice(0, 10)) {
          const { data: full } = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
          const headers = full.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "unknown";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          results.push(`- ${subject} (from: ${from})`);
        }
        return results.join("\n");
      } catch (e) {
        return `email search failed: ${e.message}`;
      }
    }

    case "draft_email": {
      if (!isOwner(message.author.id)) return denyMessage();
      const gmail = await getGmail();
      if (!gmail) return "gmail not configured";
      try {
        const to = input.to || input.recipient;
        const subject = input.subject || "(no subject)";
        const body = input.body || input.content || input.text || "";
        if (!to) return "no recipient provided";
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
        ).toString("base64url");
        await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
        return `draft created — to: ${to}, subject: "${subject}"`;
      } catch (e) {
        return `draft creation failed: ${e.message}`;
      }
    }

    case "summarize_inbox": {
      if (!isOwner(message.author.id)) return denyMessage();
      const gmail = await getGmail();
      if (!gmail) return "gmail not configured";
      try {
        const { data } = await gmail.users.messages.list({ userId: "me", maxResults: 20, q: "is:unread" });
        if (!data.messages?.length) return "inbox is clean — no unread emails";
        const subjects = [];
        for (const msg of data.messages.slice(0, 20)) {
          const { data: full } = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = full.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "unknown";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          subjects.push(`- ${subject} (from: ${from})`);
        }
        return `${data.messages.length} unread emails:\n${subjects.join("\n")}`;
      } catch (e) {
        return `inbox summary failed: ${e.message}`;
      }
    }

    case "github_repos": {
      if (!isOwner(message.author.id)) return denyMessage();
      const octokit = await getOctokit();
      if (!octokit) return "github not configured";
      try {
        const { data: repos } = await octokit.repos.listForAuthenticatedUser({
          sort: "updated", per_page: input.limit || 10,
        });
        const q = (input.query || "").toLowerCase().trim();
        const filtered = q
          ? repos.filter(r => r.full_name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q))
          : repos;
        return filtered.map(r => `- ${r.full_name} ${r.private ? "(private)" : "(public)"} \u2605${r.stargazers_count}`).join("\n") || "no repos found";
      } catch (e) {
        return `github repos failed: ${e.message}`;
      }
    }

    case "github_issues": {
      if (!isOwner(message.author.id)) return denyMessage();
      const octokit = await getOctokit();
      if (!octokit) return "github not configured";
      try {
        const { owner, repo } = resolveRepo(input);
        if (!owner || !repo) return "need a repo in owner/repo format";
        const { data: issues } = await octokit.issues.listForRepo({
          owner, repo, state: input.state || "open", per_page: input.limit || 10,
        });
        if (!issues.length) return "no issues found";
        return issues.map(i => `- #${i.number}: ${i.title} [${i.state}] (${i.user?.login})`).join("\n");
      } catch (e) {
        return `github issues failed: ${e.message}`;
      }
    }

    case "github_prs": {
      if (!isOwner(message.author.id)) return denyMessage();
      const octokit = await getOctokit();
      if (!octokit) return "github not configured";
      try {
        const { owner, repo } = resolveRepo(input);
        if (!owner || !repo) return "need a repo in owner/repo format";
        const { data: prs } = await octokit.pulls.list({
          owner, repo, state: input.state || "open", per_page: input.limit || 10,
        });
        if (!prs.length) return "no pull requests found";
        return prs.map(p => `- #${p.number}: ${p.title} [${p.state}] (${p.user?.login})`).join("\n");
      } catch (e) {
        return `github prs failed: ${e.message}`;
      }
    }

    case "github_create_issue": {
      if (!isOwner(message.author.id)) return denyMessage();
      const octokit = await getOctokit();
      if (!octokit) return "github not configured";
      try {
        const { owner, repo } = resolveRepo(input);
        const title = input.title;
        const body = input.body || input.description || "";
        if (!owner || !repo) return "need a repo in owner/repo format";
        if (!title) return "need an issue title";
        const { data: issue } = await octokit.issues.create({
          owner, repo, title, body, labels: input.labels || [],
        });
        return `issue created: ${issue.html_url}`;
      } catch (e) {
        return `github create issue failed: ${e.message}`;
      }
    }

    case "github_repo_stats": {
      if (!isOwner(message.author.id)) return denyMessage();
      const octokit = await getOctokit();
      if (!octokit) return "github not configured";
      try {
        const { owner, repo } = resolveRepo(input);
        if (!owner || !repo) return "need a repo in owner/repo format";
        const { data: r } = await octokit.repos.get({ owner, repo });
        return [
          `${r.full_name} ${r.private ? "(private)" : "(public)"}`,
          `stars: ${r.stargazers_count} | forks: ${r.forks_count} | watchers: ${r.watchers_count}`,
          `language: ${r.language || "unknown"} | size: ${r.size}KB`,
          `open issues: ${r.open_issues_count}`,
          `default branch: ${r.default_branch}`,
          `created: ${new Date(r.created_at).toLocaleDateString()} | updated: ${new Date(r.updated_at).toLocaleDateString()}`,
        ].join("\n");
      } catch (e) {
        return `github repo stats failed: ${e.message}`;
      }
    }

    case "check_deploy": {
      if (!isOwner(message.author.id)) return denyMessage();
      if (!config.renderApiKey) return "render api not configured";
      try {
        const serviceId = input.service_name || input.service_id || input.id;
        if (!serviceId) return "no service id provided";
        const res = await fetch(`https://api.render.com/v1/services/${serviceId}`, {
          headers: { Authorization: `Bearer ${config.renderApiKey}` },
        });
        const data = await res.json();
        const svc = data.service || data;
        return [
          `service: ${svc.name || serviceId}`,
          `status: ${svc.suspended || "active"}`,
          `type: ${svc.type || "unknown"}`,
          `url: ${svc.serviceDetails?.url || "n/a"}`,
          `updated: ${svc.updatedAt || "unknown"}`,
        ].join("\n");
      } catch (e) {
        return `deploy check failed: ${e.message}`;
      }
    }

    case "watch_deploy": {
      if (!isOwner(message.author.id)) return denyMessage();
      if (!config.renderApiKey) return "render api not configured";
      const service = input.service || "render";
      const projectId = input.project_id || input.id;
      if (!projectId) return "no project/service id provided";
      const ok = await db.addDeployWatch(service, projectId, message.channel.id);
      return ok ? `now watching deploys for ${projectId} on ${service}` : "failed to set deploy watch";
    }

    default:
      return undefined;
  }
}
