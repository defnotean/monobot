// ─── GitHub Commit Notifications via RSS Feed ────────────────────────────────
// Polls GitHub commit RSS feeds for configured repos, posts embeds on new commits.

import { EmbedBuilder } from "discord.js";
import { getGithubConfig, setGithubConfig } from "../database.js";
import { log } from "./logger.js";
import Parser from "rss-parser";

const parser = new Parser();

// ─── In-Memory Feed State ──────────────────────────────────────────────────

const _feedState = new Map(); // "guildId:repo" → { lastEventId, lastChecked, failureCount }
const MAX_RETRIES = 3;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/; // owner/repo format

// ─── GitHub Config Management ──────────────────────────────────────────────

export function initGithubData(loaded) {
  // Initialize feed state from loaded config if available
  if (loaded && typeof loaded === "object") {
    Object.entries(loaded).forEach(([key, value]) => {
      _feedState.set(key, value);
    });
  }
}

export function getGithubData() {
  const data = {};
  _feedState.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

export function addGithubFeed(guildId, repo, discordChannelId, branch = "main") {
  // Validate repo format (owner/repo)
  if (!GITHUB_REPO_REGEX.test(repo)) {
    return { success: false, error: "Invalid repo format (use: owner/repo)" };
  }

  const configs = getGithubConfig(guildId);

  // Max 5 feeds per guild
  if (configs.length >= 5) {
    return { success: false, error: "Maximum 5 GitHub feeds per guild" };
  }

  // Prevent duplicates
  if (configs.some((c) => c.repo === repo && c.branch === branch)) {
    return { success: false, error: "This GitHub repo/branch is already monitored" };
  }

  configs.push({
    repo,
    discordChannelId,
    branch,
    lastEventId: null,
    lastChecked: null,
  });

  setGithubConfig(guildId, configs);
  return { success: true };
}

export function removeGithubFeed(guildId, repo) {
  const configs = getGithubConfig(guildId);
  const filtered = configs.filter((c) => c.repo !== repo);

  if (filtered.length === configs.length) {
    return { success: false, error: "GitHub feed not found" };
  }

  setGithubConfig(guildId, filtered);
  // Also clean up feed state
  _feedState.delete(`${guildId}:${repo}`);
  return { success: true };
}

// ─── Feed Checker ──────────────────────────────────────────────────────────

export async function checkGithubFeeds(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await checkGuildGithubFeeds(guild);
    } catch (err) {
      log(`[GitHub] Error checking ${guild.name}: ${err.message}`);
    }
  }
}

async function checkGuildGithubFeeds(guild) {
  const configs = getGithubConfig(guild.id);
  if (!configs || configs.length === 0) return;

  for (const feed of configs) {
    try {
      const channel = guild.channels.cache.get(feed.discordChannelId)
        ?? await guild.channels.fetch(feed.discordChannelId).catch(() => null);

      if (!channel) continue;

      // Parse repo as "owner/name"
      const [owner, repoName] = feed.repo.split("/");
      if (!owner || !repoName) {
        log(`[GitHub] Invalid repo format: ${feed.repo}`);
        continue;
      }

      const branch = feed.branch || "main";
      const stateKey = `${guild.id}:${feed.repo}`;
      const state = _feedState.get(stateKey) ?? {
        lastEventId: feed.lastEventId,
        lastChecked: feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0,
        failureCount: 0,
      };

      // Fetch with retry logic
      let feedData = null;
      let lastError = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const feedUrl = `https://github.com/${owner}/${repoName}/commits/${branch}.atom`;
          feedData = await parser.parseURL(feedUrl);
          state.failureCount = 0; // Reset on success
          break;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
          }
        }
      }

      if (!feedData || !feedData.items || feedData.items.length === 0) {
        state.failureCount = (state.failureCount || 0) + 1;
        if (state.failureCount >= 3) {
          log(`[GitHub] Feed ${feed.repo}/${branch} failed 3 times: ${lastError?.message || "unknown error"}`);
        }
        _feedState.set(stateKey, state);
        continue;
      }

      // Check the most recent commit
      const latestCommit = feedData.items[0];
      // Extract commit hash from the entry ID (format: urn:uuid:... or URL)
      const commitId = latestCommit.id || latestCommit.link;

      // Only notify on new commit
      if (commitId && commitId !== state.lastEventId) {
        // Update state
        state.lastEventId = commitId;
        state.lastChecked = Date.now();
        _feedState.set(stateKey, state);

        // Update database with proper format
        const updatedConfigs = configs.map((c) =>
          c.repo === feed.repo && (c.branch || "main") === branch
            ? { ...c, lastEventId: commitId, lastChecked: new Date().toISOString() }
            : c
        );
        setGithubConfig(guild.id, updatedConfigs);

        // Extract commit details from the feed entry
        // Author is typically in the name field, commit message in title
        const author = latestCommit.author?.name || latestCommit.creator || "Unknown";
        const commitMessage = latestCommit.title || latestCommit.summary || "";

        // Send notification embed
        const embed = new EmbedBuilder()
          .setColor(0x24292e) // GitHub dark gray
          .setTitle(commitMessage.substring(0, 100))
          .setURL(latestCommit.link)
          .setAuthor({ name: `${feed.repo}/${branch} — New Commit` })
          .setDescription(`**Author:** ${author}`)
          .setTimestamp(new Date(latestCommit.pubDate));

        // Extract commit hash if available
        if (latestCommit.link) {
          const hashMatch = latestCommit.link.match(/commit\/([a-f0-9]+)/);
          if (hashMatch) {
            embed.addFields(
              { name: "Commit", value: hashMatch[1].substring(0, 7), inline: true }
            );
          }
        }

        // Build ping content from feed's ping_role_ids
        const pingIds = Array.isArray(feed.ping_role_ids) ? feed.ping_role_ids : (feed.ping_role_id ? [feed.ping_role_id] : []);
        const pingContent = pingIds.map((id) => `<@&${id}>`).join(" ");

        await channel.send({ content: pingContent || undefined, embeds: [embed] }).catch(() => {});
        log(`[GitHub] 📝 New commit on ${feed.repo}/${branch} in "${guild.name}"`);
      }
    } catch (err) {
      log(`[GitHub] Error checking feed in ${guild.name}: ${err.message}`);
    }
  }
}

// ─── Timer ────────────────────────────────────────────────────────────────

export function startGithubTimer(client) {
  // Check immediately on startup
  checkGithubFeeds(client).catch(() => {});

  // Then check every 15 minutes
  setInterval(() => checkGithubFeeds(client).catch(() => {}), 15 * 60_000);
  log("[GitHub] Feed checker started (every 15 minutes)");
}
