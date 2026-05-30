// ─── Personalization Executor ────────────────────────────────────────────────

import { setDmWelcome, setLeaveChannel, setChannelPersonality, setBadWords, setEscalation, setServerPersona } from "../../database.js";
import config from "../../config.js";
import { log } from "../../utils/logger.js";
import { safeFetch } from "@defnotean/shared/safeFetch";

const PERSONALIZATION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT_TO_TYPE = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
const ALLOWED_IMAGE_TYPES = new Set(IMAGE_EXT_TO_TYPE.values());

const HANDLED = new Set([
  "set_server_avatar", "set_server_banner", "set_server_persona",
  "set_channel_personality", "set_dm_welcome", "set_leave_channel",
  "set_bad_words", "set_escalation",
  "adjust_relationship", "adjust_mood",
]);

function getHeader(headers, name) {
  return headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()] ?? "";
}

function imageTypeFromUrl(rawUrl) {
  let path = "";
  try { path = new URL(rawUrl).pathname; }
  catch { path = String(rawUrl).split("?")[0]; }
  const ext = path.toLowerCase().split(".").pop();
  return IMAGE_EXT_TO_TYPE.get(ext) || null;
}

async function fetchPersonalizationImage(imageUrl) {
  if (!imageUrl) throw new Error("No image URL provided.");

  const res = await safeFetch(imageUrl, {
    binary: true,
    maxBytes: PERSONALIZATION_IMAGE_MAX_BYTES,
    timeoutMs: 10_000,
  }).catch((e) => {
    if (/response too large/i.test(e?.message || "")) {
      throw new Error("Image is too large (max 8 MB).");
    }
    throw e;
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Image download failed (HTTP ${res.status}).`);
  }

  const rawType = String(getHeader(res.headers, "content-type")).split(";")[0].trim().toLowerCase();
  if (rawType && !rawType.startsWith("image/") && rawType !== "application/octet-stream") {
    throw new Error("URL did not return an image.");
  }

  const contentType = rawType.startsWith("image/")
    ? rawType
    : imageTypeFromUrl(res.url) || imageTypeFromUrl(imageUrl);
  if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error("Image must be PNG, JPG, GIF, or WebP.");
  }

  return { bytes: res.bytes, contentType };
}

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findChannel, findMember } = ctx;

  switch (toolName) {
    case "set_server_avatar":
    case "set_server_banner": {
      if (!input.image_url) return "No image URL provided.";
      const field = toolName === "set_server_banner" ? "banner" : "avatar";
      try {
        const image = await fetchPersonalizationImage(input.image_url);
        const base64 = image.bytes.toString("base64");
        const dataUri = `data:${image.contentType};base64,${base64}`;
        log(`[Persona] set_server_${field}: ${Math.round(image.bytes.byteLength / 1024)}KB, type=${image.contentType}`);

        await guild.client.rest.patch(`/guilds/${guild.id}/members/@me`, {
          body: { [field]: dataUri },
        });

        log(`[Persona] set_server_${field} success for guild ${guild.id}`);
        return `Server ${field} updated successfully.`;
      } catch (err) {
        log(`[Persona] set_server_${field} error: ${err.message}`);
        return `Failed to update ${field}: ${err.message}`;
      }
    }

    case "set_server_persona": {
      const meForPersona = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      if (input.reset) {
        setServerPersona(guild.id, null);
        await meForPersona?.setNickname("Irene").catch(() => {});
        return "Server persona reset to default Irene.";
      }
      if (!input.name) return "Provide a name (or set reset: true to revert to default).";
      const personality = input.personality?.trim()
        || config.botPersonality.replace(/\bIrene\b/g, input.name);
      setServerPersona(guild.id, { name: input.name, personality });
      await meForPersona?.setNickname(input.name).catch(() => {});
      return `Server persona updated — I'll go by "${input.name}" in this server from now on.`;
    }

    case "set_channel_personality": {
      const personalityCh = input.channel_name ? findChannel(guild, input.channel_id || input.channel_name) : message.channel;
      if (!personalityCh) return `Couldn't find channel "${input.channel_name}"`;
      setChannelPersonality(guild.id, personalityCh.id, input.prompt || null);
      return input.prompt
        ? `Channel personality set for #${personalityCh.name}`
        : `Channel personality cleared for #${personalityCh.name}`;
    }

    case "set_dm_welcome": {
      setDmWelcome(guild.id, input.enabled, input.message);
      return input.enabled
        ? `DM welcome ${input.message ? "updated and " : ""}enabled — new members will get a DM when they join`
        : "DM welcome disabled";
    }

    case "set_leave_channel": {
      const leaveCh = findChannel(guild, input.channel_id || input.channel_name);
      if (!leaveCh) return `Couldn't find channel "${input.channel_name}"`;
      setLeaveChannel(guild.id, leaveCh.id, input.message || null);
      return `Leave messages will be posted in #${leaveCh.name}${input.message ? " with the custom message" : ""}`;
    }

    case "set_bad_words": {
      const words = input.words || [];
      setBadWords(guild.id, words);
      return words.length > 0
        ? `Bad word filter updated — ${words.length} word(s) will be auto-deleted`
        : "Bad word filter cleared";
    }

    case "set_escalation": {
      setEscalation(guild.id, {
        mute_at: input.mute_at ?? null,
        kick_at: input.kick_at ?? null,
        ban_at: input.ban_at ?? null,
      });
      const parts = [];
      if (input.mute_at) parts.push(`timeout at ${input.mute_at} warnings`);
      if (input.kick_at) parts.push(`kick at ${input.kick_at} warnings`);
      if (input.ban_at) parts.push(`ban at ${input.ban_at} warnings`);
      return parts.length ? `Escalation set: ${parts.join(", ")}` : "Escalation thresholds cleared";
    }

    // ─── Relationship / Mood Management ────────────────────────────
    case "adjust_relationship": {
      const { getRelationship, updateRelationship } = await import("../../database.js");
      let userId = input.user_id || input.userId || input.username;
      if (!userId) return "need a user_id to adjust relationship";
      // Models often pass a username instead of a snowflake — resolve it via
      // the guild member index so we don't end up keying affinity off literal
      // strings (and the `<@username>` mention won't render as a ping).
      if (guild && !/^\d{17,20}$/.test(String(userId))) {
        const member = findMember(guild, userId);
        if (member) userId = member.id;
        else return `couldn't find user "${userId}"`;
      }
      if (input.reset) {
        const current = getRelationship(userId);
        updateRelationship(userId, -current.affinity_score);
        return `relationship with <@${userId}> reset to neutral. ${input.reason || ""}`.trim();
      }
      // Clamp per-call delta so a hallucinated tool-call with affinity_delta
      // like 9999 can't yeet a relationship to max in one shot. Relationship
      // changes should feel earned, not magic-number'd.
      const rawDelta = Number(input.affinity_delta) || 0;
      const delta = Math.max(-25, Math.min(25, Math.round(rawDelta)));
      updateRelationship(userId, delta);
      const after = getRelationship(userId);
      const label = after.affinity_score > 50 ? "bestie" : after.affinity_score > 20 ? "friend" : after.affinity_score > 0 ? "acquaintance" : after.affinity_score > -30 ? "neutral" : "enemy";
      return `adjusted feelings toward <@${userId}> by ${delta > 0 ? "+" : ""}${delta}. now: ${label} (${after.affinity_score}). ${input.reason || ""}`.trim();
    }

    case "adjust_mood": {
      const { shiftMood: shift, getMood: mood } = await import("../../database.js");
      // Same clamp for mood/energy — these are -100..100 ranges; a single tool
      // call shouldn't move the needle more than 30 points.
      const moodD = Math.max(-30, Math.min(30, Math.round(Number(input.mood_delta) || 0)));
      const energyD = Math.max(-30, Math.min(30, Math.round(Number(input.energy_delta) || 0)));
      shift(moodD, energyD);
      const after = mood();
      return `mood shifted by ${moodD > 0 ? "+" : ""}${moodD}, energy by ${energyD > 0 ? "+" : ""}${energyD}. now: mood ${after.mood_score}, energy ${after.energy}. ${input.reason || ""}`.trim();
    }
  }
}
