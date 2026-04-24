import { sendModLog } from "../utils/logger.js";
import { logEmbed, LC } from "../utils/embeds.js";
import { log } from "../utils/logger.js";

export const name = "userUpdate";

export async function execute(oldUser, newUser) {
  if (newUser.bot) return;

  const changes = [];
  if (oldUser.username !== newUser.username) changes.push({ field: "Username", before: oldUser.username, after: newUser.username });
  if (oldUser.globalName !== newUser.globalName) changes.push({ field: "Display Name", before: oldUser.globalName || "(none)", after: newUser.globalName || "(none)" });
  if (oldUser.displayAvatarURL() !== newUser.displayAvatarURL()) changes.push({ field: "Avatar", before: "changed", after: "updated" });

  if (!changes.length) return;

  log(`[USER] ${oldUser.tag} updated: ${changes.map(c => `${c.field}: ${c.before} → ${c.after}`).join(", ")}`);

  // Split avatar changes out of the text diff — they get a real visual
  // before/after via thumbnail + image, not a textual placeholder.
  const avatarChanged = changes.some(c => c.field === "Avatar");
  const textChanges = changes.filter(c => c.field !== "Avatar");

  // Build paired lines so the Before / After fields line up row-for-row.
  const beforeLines = textChanges.map(c => `**${c.field}** · ${c.before}`);
  const afterLines  = textChanges.map(c => `**${c.field}** · ${c.after}`);

  // Send to mod log for all mutual guilds
  for (const guild of newUser.client.guilds.cache.values()) {
    if (!guild.members.cache.has(newUser.id)) continue;

    const embed = logEmbed("User Updated", LC.update)
      .setDescription(`**User:** <@${newUser.id}> (${newUser.tag})`);

    // Avatar: old avatar as thumbnail (top-right, small), new avatar as
    // main image (bottom, large). Gives a literal side-by-side picture.
    if (avatarChanged) {
      embed.setThumbnail(oldUser.displayAvatarURL({ size: 256 }));
      embed.setImage(newUser.displayAvatarURL({ size: 512 }));
    } else {
      embed.setThumbnail(newUser.displayAvatarURL({ size: 256 }));
    }

    if (beforeLines.length) {
      embed.addFields(
        { name: "📋 Before", value: beforeLines.join("\n"), inline: true },
        { name: "📝 After",  value: afterLines.join("\n"),  inline: true },
      );
    } else if (avatarChanged) {
      // Avatar-only change — label the two images so the viewer knows
      // which is which (thumbnail = old, image = new).
      embed.addFields(
        { name: "📋 Before", value: "_thumbnail →_", inline: true },
        { name: "📝 After",  value: "_main image ↓_", inline: true },
      );
    }

    await sendModLog(guild, embed);
  }
}
