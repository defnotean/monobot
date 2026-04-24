import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} from "discord.js";
import { addReminder } from "../../database.js";
import { log } from "../../utils/logger.js";

// Duration parser — accepts "5m", "1h", "30s", "2d", "1w" (case-insensitive, spaces OK).
// Returns milliseconds, or null on parse failure.
// Rejects durations > 365 days (sanity cap) or < 10 seconds.
const MIN_MS = 10_000;
const MAX_MS = 365 * 24 * 3600 * 1000;

export function parseDuration(input) {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned) return null;
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  const multipliers = {
    s: 1000, sec: 1000, secs: 1000,
    m: 60_000, min: 60_000, mins: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 7 * 86_400_000, wk: 7 * 86_400_000, wks: 7 * 86_400_000,
  };
  const ms = n * multipliers[unit];
  if (ms < MIN_MS || ms > MAX_MS) return null;
  return Math.floor(ms);
}

export const data = new ContextMenuCommandBuilder()
  .setName("remind me")
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const targetMsg = interaction.targetMessage;
  const targetId = targetMsg?.id ?? "";

  // Open a modal asking for duration. The target message ID is encoded into
  // the modal's customId so we can find it again when the submit fires.
  const modal = new ModalBuilder()
    .setCustomId(`remindme_modal:${targetId}`)
    .setTitle("remind me about this");

  const durationInput = new TextInputBuilder()
    .setCustomId("duration")
    .setLabel("when? (e.g. 10m, 1h, 2d)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("1h")
    .setRequired(true)
    .setMaxLength(20);

  modal.addComponents(new ActionRowBuilder().addComponents(durationInput));
  await interaction.showModal(modal);
}

// Modal submit handler — exported so the interactionCreate dispatcher can route
// to it. The dispatcher looks for `onModalSubmit` on the command module.
export async function onModalSubmit(interaction) {
  if (!interaction.customId.startsWith("remindme_modal:")) return false;
  const targetId = interaction.customId.split(":")[1];
  const durationRaw = interaction.fields.getTextInputValue("duration");
  const ms = parseDuration(durationRaw);

  if (ms === null) {
    await interaction.reply({
      content:
        "couldn't parse that duration. use formats like `10m`, `1h`, `30s`, `2d`. " +
        "must be between 10 seconds and 365 days.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Try to fetch the target message content — failing that, store just the link
  let snippet = "";
  let link = "";
  try {
    const msg = await interaction.channel.messages.fetch(targetId);
    snippet = String(msg.content ?? "").slice(0, 400);
    link = msg.url;
  } catch {
    link = `https://discord.com/channels/${interaction.guildId ?? "@me"}/${interaction.channelId}/${targetId}`;
  }

  const fireAt = Date.now() + ms;
  const body = snippet
    ? `**reminder** — you asked me to remind you about this:\n> ${snippet}\n${link}`
    : `**reminder** — you asked me to remind you about this: ${link}`;

  try {
    addReminder(
      interaction.user.id,
      interaction.guildId ?? null,
      interaction.channelId,
      body,
      fireAt,
    );
    const when = `<t:${Math.floor(fireAt / 1000)}:R>`;
    await interaction.reply({
      content: `got it — I'll remind you ${when}.`,
      flags: MessageFlags.Ephemeral,
    });
    log(`[RemindMe] ${interaction.user.tag} set reminder for ${Math.round(ms / 1000)}s on msg ${targetId}`);
  } catch (err) {
    log(`[RemindMe] failed for ${interaction.user.tag}: ${err?.message ?? err}`);
    await interaction.reply({
      content: `couldn't save that reminder — the database might be read-only`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
  return true;
}
