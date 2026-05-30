import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, ChannelType } from "discord.js";
import {
  getRules, addRule, removeRule, clearRules,
  setAutoModEnabled, isAutoModEnabled,
  getExemptions, addExemption, removeExemption,
} from "../../database.js";
import { quickReply } from "../../ai/providers/index.js";
import { log } from "../../utils/logger.js";

const COLOR = 0x5865F2;
const SEV_COLOR = { low: 0x95a5a6, medium: 0xf1c40f, high: 0xe74c3c };

export const data = new SlashCommandBuilder()
  .setName("rules")
  .setDescription("Manage server rules Irene enforces (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName("learn")
    .setDescription("AI-extract rules from a #rules channel and store them")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel containing your rules").setRequired(true).addChannelTypes(ChannelType.GuildText)))
  .addSubcommand((s) => s.setName("list")
    .setDescription("Show stored rules"))
  .addSubcommand((s) => s.setName("add")
    .setDescription("Add a single rule manually")
    .addStringOption((o) => o.setName("text").setDescription("The rule").setRequired(true).setMaxLength(500))
    .addStringOption((o) => o.setName("severity").setDescription("How serious is this rule")
      .addChoices({ name: "low", value: "low" }, { name: "medium", value: "medium" }, { name: "high", value: "high" })))
  .addSubcommand((s) => s.setName("remove")
    .setDescription("Remove a rule by number")
    .addIntegerOption((o) => o.setName("number").setDescription("Rule number from /rules list").setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName("clear")
    .setDescription("Wipe all stored rules"))
  .addSubcommand((s) => s.setName("enable")
    .setDescription("Turn ON proactive auto-mod (Irene applies punishments based on rules)"))
  .addSubcommand((s) => s.setName("disable")
    .setDescription("Turn OFF proactive auto-mod (rules stay stored, just no enforcement)"))
  .addSubcommand((s) => s.setName("status")
    .setDescription("Show whether auto-mod is on, rule count, exemption count"))
  .addSubcommand((s) => s.setName("exempt")
    .setDescription("Whitelist a user from a rule (or all rules)")
    .addUserOption((o) => o.setName("user").setDescription("Who to exempt").setRequired(true))
    .addIntegerOption((o) => o.setName("rule").setDescription("Rule number, or omit for ALL rules").setMinValue(1))
    .addStringOption((o) => o.setName("reason").setDescription("Why").setMaxLength(200))
    .addIntegerOption((o) => o.setName("days").setDescription("Days until exemption expires (omit = forever)").setMinValue(1).setMaxValue(365)))
  .addSubcommand((s) => s.setName("unexempt")
    .setDescription("Remove a user's exemption")
    .addUserOption((o) => o.setName("user").setDescription("Who to unexempt").setRequired(true))
    .addIntegerOption((o) => o.setName("rule").setDescription("Rule number, or omit if it's a global exemption").setMinValue(1)))
  .addSubcommand((s) => s.setName("exemptions")
    .setDescription("List active rule exemptions in this server"));

/**
 * @param {{ title: string, description?: string, color?: number, footer?: string }} opts
 */
function emb({ title, description, color = COLOR, footer }) {
  const e = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) e.setDescription(description);
  if (footer) e.setFooter({ text: footer });
  return e;
}

export async function execute(interaction) {
  if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: "you need Manage Server permission to use /rules.", flags: MessageFlags.Ephemeral });
  }
  if (!interaction.guildId) {
    return interaction.reply({ content: "/rules only works in servers.", flags: MessageFlags.Ephemeral });
  }

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case "learn":      return handleLearn(interaction);
    case "list":       return handleList(interaction);
    case "add":        return handleAdd(interaction);
    case "remove":     return handleRemove(interaction);
    case "clear":      return handleClear(interaction);
    case "enable":     return handleEnable(interaction);
    case "disable":    return handleDisable(interaction);
    case "status":     return handleStatus(interaction);
    case "exempt":     return handleExempt(interaction);
    case "unexempt":   return handleUnexempt(interaction);
    case "exemptions": return handleExemptions(interaction);
    default:           return interaction.reply({ content: `unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
  }
}

// ─── /rules learn ────────────────────────────────────────────────────────────
// Reads recent messages from a channel, asks Gemini to extract individual
// numbered rules, presents them for review (NOT auto-saved — user confirms).

async function handleLearn(interaction) {
  const channel = interaction.options.getChannel("channel");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let messages;
  try {
    const fetched = await channel.messages.fetch({ limit: 50 });
    messages = [...fetched.values()].reverse(); // chronological
  } catch (err) {
    return interaction.editReply({ content: `couldn't read ${channel}: ${err.message}` });
  }

  // Concatenate the channel's text content. Filter out bot messages — we want
  // the human-written rules, not Irene's own past responses or other bots.
  const corpus = messages
    .filter(m => !m.author.bot && m.content.trim())
    .map(m => m.content)
    .join("\n");

  if (corpus.trim().length < 20) {
    return interaction.editReply({ content: `${channel} has no usable text content. Try /rules add to enter rules manually.` });
  }

  const systemInstruction = [
    "You are extracting individual rules from a Discord server's rules channel.",
    "Read the user's text and identify each distinct rule.",
    "Return ONLY a JSON array of objects, with no commentary, no markdown fences, no preamble.",
    "Each object has shape: { \"text\": string, \"severity\": \"low\" | \"medium\" | \"high\" }",
    "Severity guide:",
    "  low    — minor etiquette (English-only, no spam, use right channels)",
    "  medium — community standards (banter ok, no targeted harassment, no self-promo)",
    "  high   — TOS-level (NSFW, slurs, threats, doxxing)",
    "Examples of NON-rules to ignore: server welcome text, decoration emojis, the date the server was made, descriptions of channels.",
    "If you can't find any rules, return an empty array [].",
    "Output exactly: a single JSON array.",
  ].join("\n");

  let raw;
  try {
    raw = await quickReply(interaction.client, systemInstruction, corpus, null);
  } catch (err) {
    return interaction.editReply({ content: `AI extraction failed: ${err?.message ?? err}` });
  }

  let parsed;
  try {
    // The model sometimes wraps in ```json … ``` even when told not to. Strip safely.
    const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end < 0 || end <= start) throw new Error("no JSON array in response");
    parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch (err) {
    return interaction.editReply({ content: `couldn't parse AI output as JSON: ${err.message}\n\nRaw response:\n\`\`\`\n${String(raw ?? "").slice(0, 500)}\n\`\`\`` });
  }

  // Save what the AI returned. Skip duplicates / empty / oversized.
  const added = [];
  const skipped = [];
  for (const item of parsed) {
    const text = String(item?.text ?? "").trim();
    if (!text) { skipped.push("(empty)"); continue; }
    const severity = ["low", "medium", "high"].includes(item?.severity) ? item.severity : "medium";
    const r = addRule(interaction.guildId, text, severity, interaction.user.id);
    if (r.success) added.push(`#${r.rule.number} [${r.rule.severity}] ${r.rule.text}`);
    else skipped.push(`(${r.reason}) ${text.slice(0, 50)}`);
  }

  const lines = [
    `Extracted from ${channel}:`,
    "",
    added.length ? `**Added ${added.length}:**\n${added.join("\n")}` : "(no rules added)",
  ];
  if (skipped.length) lines.push("", `Skipped ${skipped.length}: ${skipped.slice(0, 3).join(" · ")}${skipped.length > 3 ? " …" : ""}`);
  lines.push("", "Run `/rules list` to review. Auto-mod is OFF until you run `/rules enable`.");
  await interaction.editReply({ embeds: [emb({ title: "rules learned", description: lines.join("\n") })] });
  log(`[Rules] ${interaction.user.tag} learned ${added.length} rules from ${channel.name} in ${interaction.guild.name}`);
}

// ─── /rules list ─────────────────────────────────────────────────────────────

async function handleList(interaction) {
  const rules = getRules(interaction.guildId);
  if (rules.length === 0) {
    return interaction.reply({
      embeds: [emb({ title: "no rules stored", description: "use `/rules learn channel:#rules` or `/rules add` to add rules." })],
      flags: MessageFlags.Ephemeral,
    });
  }
  const sorted = [...rules].sort((a, b) => a.number - b.number);
  const lines = sorted.map(r => `**#${r.number}** [${r.severity}] ${r.text}`);
  await interaction.reply({
    embeds: [emb({
      title: `server rules (${rules.length})`,
      description: lines.join("\n").slice(0, 4000),
      footer: `auto-mod: ${isAutoModEnabled(interaction.guildId) ? "ON" : "OFF"}`,
    })],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /rules add / remove / clear ─────────────────────────────────────────────

async function handleAdd(interaction) {
  const text = interaction.options.getString("text");
  const severity = interaction.options.getString("severity") || "medium";
  const r = addRule(interaction.guildId, text, severity, interaction.user.id);
  if (!r.success) {
    return interaction.reply({ content: `couldn't add: ${r.reason}`, flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({
    embeds: [emb({
      title: `rule #${r.rule.number} added`,
      description: `[${r.rule.severity}] ${r.rule.text}`,
      color: SEV_COLOR[r.rule.severity],
    })],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemove(interaction) {
  const number = interaction.options.getInteger("number");
  const r = removeRule(interaction.guildId, number);
  if (!r.success) return interaction.reply({ content: r.reason, flags: MessageFlags.Ephemeral });
  await interaction.reply({
    embeds: [emb({ title: `rule #${number} removed`, description: r.removed.text, color: SEV_COLOR[r.removed.severity] })],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleClear(interaction) {
  const r = clearRules(interaction.guildId);
  await interaction.reply({
    embeds: [emb({ title: "rules cleared", description: `removed ${r.count} rule${r.count === 1 ? "" : "s"}.` })],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /rules enable / disable / status ────────────────────────────────────────

async function handleEnable(interaction) {
  const rules = getRules(interaction.guildId);
  if (rules.length === 0) {
    return interaction.reply({
      content: "no rules stored — add some with `/rules learn` or `/rules add` first. enabling auto-mod with no rules would do nothing.",
      flags: MessageFlags.Ephemeral,
    });
  }
  setAutoModEnabled(interaction.guildId, true);
  await interaction.reply({
    embeds: [emb({
      title: "auto-mod ENABLED",
      description: `Irene will now check messages against ${rules.length} rule${rules.length === 1 ? "" : "s"} and apply punishments when warranted. Use \`/rules disable\` to turn off. Use \`/rules exempt user:@X\` to whitelist someone.`,
      color: 0x10B981,
    })],
    flags: MessageFlags.Ephemeral,
  });
  log(`[Rules] auto-mod ENABLED in ${interaction.guild.name} by ${interaction.user.tag}`);
}

async function handleDisable(interaction) {
  setAutoModEnabled(interaction.guildId, false);
  await interaction.reply({
    embeds: [emb({ title: "auto-mod DISABLED", description: "rules stay stored. Irene will no longer auto-punish.", color: 0x95a5a6 })],
    flags: MessageFlags.Ephemeral,
  });
  log(`[Rules] auto-mod DISABLED in ${interaction.guild.name} by ${interaction.user.tag}`);
}

async function handleStatus(interaction) {
  const rules = getRules(interaction.guildId);
  const exemptions = getExemptions(interaction.guildId);
  const enabled = isAutoModEnabled(interaction.guildId);
  await interaction.reply({
    embeds: [emb({
      title: "auto-mod status",
      description: [
        `**state:** ${enabled ? "🟢 enabled" : "🔴 disabled"}`,
        `**rules:** ${rules.length}`,
        `**exemptions:** ${exemptions.length}`,
      ].join("\n"),
    })],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /rules exempt / unexempt / exemptions ───────────────────────────────────

async function handleExempt(interaction) {
  const user = interaction.options.getUser("user");
  const ruleNumber = interaction.options.getInteger("rule"); // null = global
  const reason = interaction.options.getString("reason") || null;
  const days = interaction.options.getInteger("days");
  const expiresAt = days ? Date.now() + days * 86_400_000 : null;

  if (ruleNumber !== null) {
    const exists = getRules(interaction.guildId).some(r => r.number === ruleNumber);
    if (!exists) {
      return interaction.reply({ content: `no rule numbered ${ruleNumber}. run /rules list to see numbers.`, flags: MessageFlags.Ephemeral });
    }
  }

  const r = addExemption(interaction.guildId, user.id, ruleNumber, reason, interaction.user.id, expiresAt);
  if (!r.success) return interaction.reply({ content: `couldn't exempt: ${r.reason}`, flags: MessageFlags.Ephemeral });

  const scope = ruleNumber === null ? "ALL rules" : `rule #${ruleNumber}`;
  const expires = expiresAt ? ` until <t:${Math.floor(expiresAt / 1000)}:R>` : ` (no expiry)`;
  await interaction.reply({
    embeds: [emb({
      title: "exemption added",
      description: `${user} is exempt from **${scope}**${expires}.${reason ? `\nreason: ${reason}` : ""}`,
      color: 0x10B981,
    })],
    flags: MessageFlags.Ephemeral,
  });
  log(`[Rules] ${interaction.user.tag} exempted ${user.tag} from ${scope} in ${interaction.guild.name}`);
}

async function handleUnexempt(interaction) {
  const user = interaction.options.getUser("user");
  const ruleNumber = interaction.options.getInteger("rule"); // null = global
  const r = removeExemption(interaction.guildId, user.id, ruleNumber);
  if (!r.success) return interaction.reply({ content: r.reason, flags: MessageFlags.Ephemeral });
  const scope = ruleNumber === null ? "ALL rules" : `rule #${ruleNumber}`;
  await interaction.reply({
    embeds: [emb({ title: "exemption removed", description: `${user} is no longer exempt from ${scope}.` })],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleExemptions(interaction) {
  const list = getExemptions(interaction.guildId);
  if (list.length === 0) {
    return interaction.reply({ embeds: [emb({ title: "no exemptions" })], flags: MessageFlags.Ephemeral });
  }
  const lines = list.slice(0, 25).map(e => {
    const scope = e.ruleNumber === null ? "ALL" : `#${e.ruleNumber}`;
    const expires = e.expiresAt ? `<t:${Math.floor(e.expiresAt / 1000)}:R>` : "never";
    return `<@${e.userId}> · ${scope} · expires ${expires}${e.reason ? ` · ${e.reason.slice(0, 60)}` : ""}`;
  });
  await interaction.reply({
    embeds: [emb({
      title: `active exemptions (${list.length})`,
      description: lines.join("\n").slice(0, 4000),
      footer: list.length > 25 ? `showing 25 of ${list.length}` : undefined,
    })],
    flags: MessageFlags.Ephemeral,
  });
}
