import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { successEmbed, errorEmbed, infoEmbed } from "../../utils/embeds.js";
import { hasAdministratorMember } from "../../utils/permissions.js";
import { getServerPersona, setServerPersona } from "../../database.js";
import { log } from "../../utils/logger.js";
import config from "../../config.js";

export const data = new SlashCommandBuilder()
  .setName("persona")
  .setDescription("Customize the bot's name and personality for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set a custom persona for this server")
      .addStringOption((o) =>
        o.setName("name").setDescription("The name the bot will use in this server (e.g. Gremlin.exe)").setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("personality")
          .setDescription("Full personality prompt (leave blank to auto-generate from name)")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("reset").setDescription("Reset to the default Irene personality")
  )
  .addSubcommand((sub) =>
    sub.setName("view").setDescription("View the current persona for this server")
  );

export async function execute(interaction) {
  if (!hasAdministratorMember(interaction.member)) {
    return interaction.reply({
      embeds: [errorEmbed("No Permission", "You need **Administrator** to manage my server persona.")],
      ephemeral: true,
    });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === "view") {
    const persona = getServerPersona(guildId);
    if (!persona) {
      return interaction.reply({
        embeds: [
          infoEmbed("Current Persona", "**Name:** Irene\n**Personality:** Default (no override set)"),
        ],
        ephemeral: true,
      });
    }
    const preview = persona.personality
      ? persona.personality.slice(0, 400) + (persona.personality.length > 400 ? "…" : "")
      : "_Auto-generated from name_";
    return interaction.reply({
      embeds: [
        infoEmbed("Current Persona", `**Name:** ${persona.name}\n\n**Personality:**\n${preview}`),
      ],
      ephemeral: true,
    });
  }

  if (sub === "reset") {
    setServerPersona(guildId, null);
    await interaction.guild.members.me.setNickname("Irene").catch((e) => log(`[Persona] Nickname change failed: ${e.message}`));
    return interaction.reply({
      embeds: [successEmbed("Persona Reset", "Reverted to the default Irene personality.")],
      ephemeral: true,
    });
  }

  if (sub === "set") {
    const name       = interaction.options.getString("name");
    const customPers = interaction.options.getString("personality");

    if (name.length > 80) {
      return interaction.reply({
        embeds: [errorEmbed("Name Too Long", "Persona name must be 80 characters or fewer.")],
        ephemeral: true,
      });
    }

    const personality = customPers
      ? customPers.trim()
      : config.botPersonality.replace(/\bIrene\b/g, name);

    setServerPersona(guildId, { name, personality });
    await interaction.guild.members.me.setNickname(name).catch((e) => log(`[Persona] Nickname change failed: ${e.message}`));

    return interaction.reply({
      embeds: [
        successEmbed(
          "Persona Updated",
          `The bot will now go by **${name}** in this server.\n\n` +
            (customPers
              ? "Using the custom personality you provided."
              : `No personality provided — auto-generated from the default template with the name **${name}**.`) +
            "\n\nThe change takes effect on the next message."
        ),
      ],
      ephemeral: true,
    });
  }
}
