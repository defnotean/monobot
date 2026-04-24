import { sendModLog } from "../utils/logger.js";
import { logEvent } from "../utils/embeds.js";

export const name = "guildUpdate";

const VERIFICATION_LEVELS = ["None", "Low", "Medium", "High", "Very High"];
const CONTENT_FILTER = ["Disabled", "Members without roles", "All members"];
const NOTIFICATIONS = ["All Messages", "Only @mentions"];

export async function execute(oldGuild, newGuild) {
  const changedKeys = [];
  const beforeLines = [];
  const afterLines = [];

  if (oldGuild.name !== newGuild.name) {
    changedKeys.push("Name");
    beforeLines.push(`**Name** · \`${oldGuild.name}\``);
    afterLines.push(`**Name** · \`${newGuild.name}\``);
  }
  if (oldGuild.description !== newGuild.description) {
    changedKeys.push("Description");
    beforeLines.push(`**Description** · ${oldGuild.description || "*(none)*"}`);
    afterLines.push(`**Description** · ${newGuild.description || "*(none)*"}`);
  }
  if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
    changedKeys.push("Verification");
    beforeLines.push(`**Verification** · ${VERIFICATION_LEVELS[oldGuild.verificationLevel] ?? oldGuild.verificationLevel}`);
    afterLines.push(`**Verification** · ${VERIFICATION_LEVELS[newGuild.verificationLevel] ?? newGuild.verificationLevel}`);
  }
  if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) {
    changedKeys.push("Content Filter");
    beforeLines.push(`**Content Filter** · ${CONTENT_FILTER[oldGuild.explicitContentFilter] ?? oldGuild.explicitContentFilter}`);
    afterLines.push(`**Content Filter** · ${CONTENT_FILTER[newGuild.explicitContentFilter] ?? newGuild.explicitContentFilter}`);
  }
  if (oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications) {
    changedKeys.push("Default Notifications");
    beforeLines.push(`**Notifications** · ${NOTIFICATIONS[oldGuild.defaultMessageNotifications] ?? oldGuild.defaultMessageNotifications}`);
    afterLines.push(`**Notifications** · ${NOTIFICATIONS[newGuild.defaultMessageNotifications] ?? newGuild.defaultMessageNotifications}`);
  }
  if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) {
    changedKeys.push("Vanity URL");
    beforeLines.push(`**Vanity** · ${oldGuild.vanityURLCode ? `\`${oldGuild.vanityURLCode}\`` : "*(none)*"}`);
    afterLines.push(`**Vanity** · ${newGuild.vanityURLCode ? `\`${newGuild.vanityURLCode}\`` : "*(none)*"}`);
  }
  if (oldGuild.afkChannelId !== newGuild.afkChannelId) {
    changedKeys.push("AFK Channel");
    beforeLines.push(`**AFK** · ${oldGuild.afkChannelId ? `<#${oldGuild.afkChannelId}>` : "*(none)*"}`);
    afterLines.push(`**AFK** · ${newGuild.afkChannelId ? `<#${newGuild.afkChannelId}>` : "*(none)*"}`);
  }
  if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
    changedKeys.push("System Channel");
    beforeLines.push(`**System** · ${oldGuild.systemChannelId ? `<#${oldGuild.systemChannelId}>` : "*(none)*"}`);
    afterLines.push(`**System** · ${newGuild.systemChannelId ? `<#${newGuild.systemChannelId}>` : "*(none)*"}`);
  }

  // Visual changes get their own flags + image previews
  const iconChanged = oldGuild.icon !== newGuild.icon;
  const bannerChanged = oldGuild.banner !== newGuild.banner;
  const splashChanged = oldGuild.splash !== newGuild.splash;
  if (iconChanged) changedKeys.push("Icon");
  if (bannerChanged) changedKeys.push("Banner");
  if (splashChanged) changedKeys.push("Splash");

  if (!changedKeys.length) return;

  let actor = null;
  let reason = null;
  try {
    const audit = await newGuild.fetchAuditLogs({ type: 1, limit: 1 }); // GUILD_UPDATE
    const entry = audit.entries.first();
    if (entry && Date.now() - entry.createdTimestamp < 5000) {
      actor = entry.executor;
      reason = entry.reason;
    }
  } catch {}

  const diffFields = beforeLines.length
    ? [
        { name: "📋 Before", value: beforeLines.join("\n"), inline: true },
        { name: "📝 After",  value: afterLines.join("\n"),  inline: true },
      ]
    : [];

  // Show icon/banner/splash changes as their own field rows with links
  const visualLines = [];
  if (iconChanged) {
    const before = oldGuild.iconURL({ size: 256 });
    const after  = newGuild.iconURL({ size: 256 });
    visualLines.push(`**Icon** · ${before ? `[before](${before})` : "*(none)*"} → ${after ? `[after](${after})` : "*(removed)*"}`);
  }
  if (bannerChanged) {
    const before = oldGuild.bannerURL({ size: 1024 });
    const after  = newGuild.bannerURL({ size: 1024 });
    visualLines.push(`**Banner** · ${before ? `[before](${before})` : "*(none)*"} → ${after ? `[after](${after})` : "*(removed)*"}`);
  }
  if (splashChanged) {
    const before = oldGuild.splashURL({ size: 1024 });
    const after  = newGuild.splashURL({ size: 1024 });
    visualLines.push(`**Invite Splash** · ${before ? `[before](${before})` : "*(none)*"} → ${after ? `[after](${after})` : "*(removed)*"}`);
  }
  const visualFields = visualLines.length
    ? [{ name: "🖼️ Visual Changes", value: visualLines.join("\n"), inline: false }]
    : [];

  await sendModLog(newGuild, logEvent({
    kind: "audit",
    title: "Server Settings Updated",
    actor,
    reason: reason || undefined,
    description: `Server-level settings were changed${actor ? ` by <@${actor.id}>` : ""}. Changed: ${changedKeys.map((k) => `\`${k}\``).join(", ")}.`,
    meta: {
      "Members": String(newGuild.memberCount),
      "Boost Tier": `Level ${newGuild.premiumTier ?? 0}`,
      "Boost Count": String(newGuild.premiumSubscriptionCount ?? 0),
    },
    fields: [...diffFields, ...visualFields],
    // Small server icon as thumbnail, new banner as hero image if changed
    thumbnail: newGuild.iconURL({ size: 256 }) || undefined,
    image: bannerChanged && newGuild.bannerURL({ size: 1024 }) || undefined,
    color: 0x5865f2,
    footerNote: `Guild ID: ${newGuild.id}`,
  }));
}
