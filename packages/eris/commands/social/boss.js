import { SlashCommandBuilder, EmbedBuilder , MessageFlags } from "discord.js";
import { updateBalance, tryDeductBalance, getActiveBoss, spawnBoss, damageBoss, getPetBattleStats } from "../../database.js";
import { bossEmbed } from "../../ai/gameVisuals.js";
import { getRandomBoss, calculateDamage } from "../../ai/stocks.js";

export const data = new SlashCommandBuilder()
  .setName("boss")
  .setDescription("Cooperative boss battles")
  .addSubcommand(sub => sub.setName("spawn").setDescription("Spawn a boss (costs 500 coins)"))
  .addSubcommand(sub => sub.setName("attack").setDescription("Attack the active boss (costs 10 coins)"))
  .addSubcommand(sub => sub.setName("status").setDescription("View the current boss"));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  if (!guildId) return interaction.reply({ content: "this only works in servers", flags: MessageFlags.Ephemeral });

  if (sub === "spawn") {
    const existing = await getActiveBoss(guildId);
    if (existing) return interaction.reply({ content: `there's already an active boss: **${existing.boss_name}** (${existing.boss_hp}/${existing.max_hp} HP)`, flags: MessageFlags.Ephemeral });

    const boss = getRandomBoss();
    const debit = await tryDeductBalance(userId, 500, "boss_spawn", boss.name);
    if (!debit.ok) {
      const content = debit.reason === "insufficient" ? "spawning a boss costs 500 coins" : `failed to spawn boss: ${debit.reason}`;
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    const spawned = await spawnBoss(guildId, boss.name, boss.emoji, boss.hp, boss.phases, boss.lootMultiplier);
    if (!spawned) {
      await updateBalance(userId, 500, "boss_spawn_refund", boss.name).catch(() => {});
      return interaction.reply({ content: "failed to spawn boss — try again", flags: MessageFlags.Ephemeral });
    }

    const { embed, row } = bossEmbed(boss.name, boss.emoji, boss.hp, boss.hp, null, null);
    embed.setDescription(`${embed.data.description}\n\n**${interaction.user.username}** summoned this boss!\nAttack with \`/boss attack\` (10 coins per swing)`);
    await interaction.reply({ embeds: [embed], components: row ? [row] : [] });
  }

  if (sub === "attack") {
    const boss = await getActiveBoss(guildId);
    if (!boss) return interaction.reply({ content: "no active boss — use `/boss spawn` to summon one", flags: MessageFlags.Ephemeral });

    const debit = await tryDeductBalance(userId, 10, "boss_attack", boss.boss_name);
    if (!debit.ok) {
      const content = debit.reason === "insufficient" ? "attacking costs 10 coins" : `attack failed: ${debit.reason}`;
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    // Calculate damage with pet bonus
    const pet = await getPetBattleStats(userId);
    const petBonus = pet ? Math.floor(pet.attack * 1.5) : 0;
    const baseDamage = calculateDamage(1, false);
    const totalDamage = baseDamage + petBonus;
    const isCrit = totalDamage > baseDamage * 1.5;

    const result = await damageBoss(boss.id, userId, totalDamage);
    if (!result) {
      await updateBalance(userId, 10, "boss_attack_refund", boss.boss_name).catch(() => {});
      return interaction.reply({ content: "something went wrong", flags: MessageFlags.Ephemeral });
    }
    if (result.alreadyDead) {
      await updateBalance(userId, 10, "boss_attack_refund", boss.boss_name).catch(() => {});
      return interaction.reply({ content: "that boss is already defeated!", flags: MessageFlags.Ephemeral });
    }

    // Phase change notifications
    const oldPhase = boss.phase || 1;
    const newPhase = result.phase;
    let phaseMsg = "";
    if (newPhase > oldPhase) {
      const phaseEffects = {
        2: "🔥 **Phase 2!** The boss is enraged — it starts dealing counter-damage!",
        3: "💀 **Phase 3!** The boss raises a shield — all damage reduced by 30%!",
        4: "🌪️ **FINAL PHASE!** The boss is desperate — massive counter-attacks!",
      };
      phaseMsg = phaseEffects[newPhase] || `⚡ Phase ${newPhase}!`;
    }

    if (result.defeated) {
      // Boss defeated! Distribute loot
      const totalLoot = Math.floor(boss.max_hp * (boss.loot_multiplier || 2) * 0.1);
      const participants = result.participants || {};
      const totalDmg = Object.values(participants).reduce((s, d) => s + d, 0);

      const lootLines = [];
      for (const [pid, dmg] of Object.entries(participants)) {
        const share = Math.floor(totalLoot * (dmg / totalDmg));
        if (share > 0) {
          await updateBalance(pid, share, "boss_loot", boss.boss_name);
          const member = interaction.guild?.members.cache.get(pid);
          lootLines.push(`${member?.displayName || "Unknown"}: **${share}** coins (${dmg} damage)`);
        }
      }

      const victoryEmbed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`${boss.boss_emoji || "💀"} ${boss.boss_name} — DEFEATED!`)
        .setDescription(`**${interaction.user.username}** dealt the final blow!${isCrit ? " **CRITICAL HIT!** 💥" : ""}${petBonus > 0 ? ` (Pet bonus: +${petBonus})` : ""}`)
        .addFields(
          { name: "💰 Loot Distribution", value: lootLines.join("\n") || "No loot", inline: false },
          { name: "Total Loot", value: `**${totalLoot}** coins`, inline: true },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [victoryEmbed] });
    }

    // Boss still alive
    const { embed, row } = bossEmbed(boss.boss_name, boss.boss_emoji, result.boss_hp, boss.max_hp, interaction.user.username, totalDamage);
    let content = isCrit ? "💥 **CRITICAL HIT!**" : "";
    if (petBonus > 0) content += ` (Pet bonus: +${petBonus})`;
    if (phaseMsg) content += `\n${phaseMsg}`;

    await interaction.reply({ embeds: [embed], components: row ? [row] : [], content: content || undefined });
  }

  if (sub === "status") {
    const boss = await getActiveBoss(guildId);
    if (!boss) return interaction.reply({ content: "no active boss right now — use `/boss spawn`", flags: MessageFlags.Ephemeral });

    const participants = boss.participants || {};
    const sorted = Object.entries(participants).sort(([, a], [, b]) => b - a).slice(0, 10);
    const damageLines = sorted.map(([pid, dmg], i) => {
      const medals = ["👑", "🥈", "🥉"];
      const prefix = medals[i] || `${i + 1}.`;
      const member = interaction.guild?.members.cache.get(pid);
      return `${prefix} ${member?.displayName || "Unknown"} — **${dmg}** damage`;
    });

    const phaseNames = { 1: "Normal", 2: "Enraged 🔥", 3: "Shielded 🛡️", 4: "Desperate 🌪️" };
    const { embed } = bossEmbed(boss.boss_name, boss.boss_emoji, boss.boss_hp, boss.max_hp, null, null);
    embed.addFields(
      { name: "Phase", value: phaseNames[boss.phase] || "Normal", inline: true },
      { name: "Top Attackers", value: damageLines.join("\n") || "No attacks yet", inline: false },
    );

    await interaction.reply({ embeds: [embed] });
  }
}
