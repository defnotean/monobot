import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { getGuildSettings, getScrimStats, updateScrimStats } from "../database.js";
import { log } from "./logger.js";
import { errorEmbed, successEmbed } from "./embeds.js";

// Active lobbies cache: messageId -> { host, players, game, teamSize, status, team1, team2, vcs }
export const activeScrims = new Map();

// Expire stale lobbies every 5 minutes — prevents memory leaks from abandoned scrims
const SCRIM_EXPIRY_MS = 2 * 60 * 60_000; // 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, scrim] of activeScrims) {
    if (scrim.status === "lobby" && scrim.createdAt && (now - scrim.createdAt > SCRIM_EXPIRY_MS)) {
      activeScrims.delete(id);
      log(`[Scrim] Expired stale lobby "${scrim.game}" (${id}) after 2h`);
    }
  }
}, 5 * 60_000);

// Simplified ELO calculation
const K_FACTOR = 32;

function calculateEloDelta(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(K_FACTOR * (scoreA - expectedA));
}

// Balance teams greedy approach
function balanceTeams(players, guildId, game) {
  const stats = getScrimStats(guildId, game);
  const arr = [...players].map(id => ({ id, elo: stats[id]?.elo ?? 1200 }));
  arr.sort((a, b) => b.elo - a.elo); // Sort descending

  const team1 = [];
  const team2 = [];
  let elo1 = 0;
  let elo2 = 0;

  for (const p of arr) {
    if (team1.length < players.size / 2 && (elo1 <= elo2 || team2.length >= players.size / 2)) {
      team1.push(p);
      elo1 += p.elo;
    } else {
      team2.push(p);
      elo2 += p.elo;
    }
  }

  return { team1, team2, elo1: Math.round(elo1 / (team1.length || 1)), elo2: Math.round(elo2 / (team2.length || 1)) };
}

export function buildLobbyEmbed(scrim) {
  const needed = scrim.teamSize * 2;
  const current = scrim.players.size;
  
  const playersList = [...scrim.players].map(id => `<@${id}>`).join("\n") || "No one yet...";
  
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${scrim.game} Scrim Lobby`)
    .setDescription(`Host: <@${scrim.host}>\nFormat: ${scrim.teamSize}v${scrim.teamSize}\n\n**Players (${current}/${needed}):**\n${playersList}`)
    .setColor(current === needed ? 0x57F287 : 0x5865F2)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scrim:join:${scrim.id}`).setLabel("Join").setStyle(ButtonStyle.Success).setEmoji("⚔️"),
    new ButtonBuilder().setCustomId(`scrim:leave:${scrim.id}`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scrim:start:${scrim.id}`).setLabel("Force Start").setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

export async function manageScrimInteraction(interaction) {
  const [, action, id] = interaction.customId.split(":");
  const scrim = activeScrims.get(id);

  if (!scrim) {
    return interaction.reply({ content: "This scrim lobby has expired or ended.", ephemeral: true });
  }

  const userId = interaction.user.id;

  if (action === "join") {
    if (scrim.status !== "lobby") return interaction.reply({ content: "The match has already started!", ephemeral: true });
    if (scrim.players.has(userId)) return interaction.reply({ content: "You're already in the lobby.", ephemeral: true });
    if (scrim.players.size >= scrim.teamSize * 2) return interaction.reply({ content: "Lobby is full!", ephemeral: true });

    scrim.players.add(userId);
    await interaction.update(buildLobbyEmbed(scrim));
  } else if (action === "leave") {
    if (scrim.status !== "lobby") return interaction.reply({ content: "You can't leave a match in progress!", ephemeral: true });
    if (!scrim.players.has(userId)) return interaction.reply({ content: "You aren't in this lobby.", ephemeral: true });

    scrim.players.delete(userId);
    await interaction.update(buildLobbyEmbed(scrim));
  } else if (action === "start") {
    if (scrim.host !== userId) return interaction.reply({ content: "Only the host can start the scrim.", ephemeral: true });
    if (scrim.players.size < 2 || scrim.players.size % 2 !== 0) {
      return interaction.reply({ content: "You need an even number of players (minimum 2) to start.", ephemeral: true });
    }

    scrim.status = "active";
    const { team1, team2, elo1, elo2 } = balanceTeams(scrim.players, interaction.guild.id, scrim.game);
    scrim.team1 = team1.map(p => p.id);
    scrim.team2 = team2.map(p => p.id);

    // Create Voice Channels
    await interaction.deferUpdate();
    let parentId = interaction.channel.parentId;
    const settings = getGuildSettings(interaction.guild.id);
    if (settings?.create_vc_channel_id) {
       const trigger = interaction.guild.channels.cache.get(settings.create_vc_channel_id);
       if (trigger) parentId = trigger.parentId;
    }

    try {
      const vcs = [];
      const vc1 = await interaction.guild.channels.create({
        name: `🔷 Team 1 — ${scrim.game}`,
        type: ChannelType.GuildVoice,
        parent: parentId,
        userLimit: team1.length + 1
      });
      const vc2 = await interaction.guild.channels.create({
        name: `🔶 Team 2 — ${scrim.game}`,
        type: ChannelType.GuildVoice,
        parent: parentId,
        userLimit: team2.length + 1
      });
      scrim.vcs = [vc1.id, vc2.id];

      // Move players
      for (const p of team1) {
        const member = interaction.guild.members.cache.get(p.id);
        if (member?.voice?.channel) await member.voice.setChannel(vc1).catch(()=>{});
      }
      for (const p of team2) {
        const member = interaction.guild.members.cache.get(p.id);
        if (member?.voice?.channel) await member.voice.setChannel(vc2).catch(()=>{});
      }
    } catch (e) {
      log(`[Scrim] Failed creating voice channels: ${e.message}`);
    }

    const t1Text = team1.map(p => `<@${p.id}> (${p.elo} ELO)`).join("\n");
    const t2Text = team2.map(p => `<@${p.id}> (${p.elo} ELO)`).join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ Match Live: ${scrim.game}`)
      .setDescription(`The match has begun! Teams have been balanced and moved to their voice channels.`)
      .addFields(
        { name: `🔷 Team 1 (Avg ELO: ${elo1})`, value: t1Text || "None", inline: true },
        { name: "🆚", value: "---", inline: true },
        { name: `🔶 Team 2 (Avg ELO: ${elo2})`, value: t2Text || "None", inline: true }
      )
      .setColor(0xED8E00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`scrim:win1:${scrim.id}`).setLabel("Team 1 Won").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`scrim:win2:${scrim.id}`).setLabel("Team 2 Won").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`scrim:cancel:${scrim.id}`).setLabel("Cancel Match").setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ content: `<@${scrim.host}>`, embeds: [embed], components: [row] });

  } else if (action === "win1" || action === "win2" || action === "cancel") {
    if (!scrim.players.has(userId) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only actively participating players can securely vote on the outcome.", ephemeral: true });
    }

    if (!scrim.votes) scrim.votes = new Map();
    scrim.votes.set(userId, action);

    const win1Votes = [...scrim.votes.values()].filter(v => v === "win1").length;
    const win2Votes = [...scrim.votes.values()].filter(v => v === "win2").length;
    const cancelVotes = [...scrim.votes.values()].filter(v => v === "cancel").length;

    const majority = Math.floor(scrim.players.size / 2) + 1;

    let outcome = null;
    if (win1Votes >= majority) outcome = "win1";
    else if (win2Votes >= majority) outcome = "win2";
    else if (cancelVotes >= majority) outcome = "cancel";

    if (!outcome) {
      const remaining = majority - Math.max(win1Votes, win2Votes, cancelVotes);
      let voteName = action === "win1" ? "Team 1 Win" : action === "win2" ? "Team 2 Win" : "Cancel Match";
      return interaction.reply({ content: `✅ Your vote for **${voteName}** was secured.\n*Needs **${remaining}** more matching votes for a majority.*`, ephemeral: true });
    }

    await interaction.deferUpdate();
    
    // Cleanup VCs
    for (const vcId of (scrim.vcs || [])) {
      const channel = interaction.guild.channels.cache.get(vcId);
      if (channel) await channel.delete("Match ended").catch(()=>{});
    }

    if (outcome === "cancel") {
      activeScrims.delete(id);
      return interaction.editReply({ embeds: [errorEmbed("Match Canceled", "The match was voided by majority vote. No ELO was updated.")], components: [] });
    }

    if (outcome === "win1" || outcome === "win2") {
      scrim.status = "mvp_voting";
      scrim.winner = outcome;
      scrim.mvpVotes = new Map();
      scrim.scoreStr = "TBD - TBD";

      const getOpts = (arr) => arr.map(uid => ({ label: interaction.client.users.cache.get(uid)?.username || uid, value: uid }));
      
      const t1Select = new StringSelectMenuBuilder().setCustomId(`scrim:mvp1:${id}`).setPlaceholder("Vote for Team 1 MVP").addOptions(getOpts(scrim.team1));
      const t2Select = new StringSelectMenuBuilder().setCustomId(`scrim:mvp2:${id}`).setPlaceholder("Vote for Team 2 MVP").addOptions(getOpts(scrim.team2));
      
      const row3 = new ActionRowBuilder().addComponents(
         new ButtonBuilder().setCustomId(`scrim:score:${id}`).setLabel("Set Score (Host)").setStyle(ButtonStyle.Secondary),
         new ButtonBuilder().setCustomId(`scrim:finalize:${id}`).setLabel("Finalize Match").setStyle(ButtonStyle.Success)
      );

      return interaction.editReply({ 
        embeds: [successEmbed("Match Reporting Phase", `**${outcome === "win1" ? "🔷 Team 1" : "🔶 Team 2"} Won!**\n\nPlayers: Cast your MVP votes below.\nHost: Set the final round score, then click Finalize.`)], 
        components: [new ActionRowBuilder().addComponents(t1Select), new ActionRowBuilder().addComponents(t2Select), row3] 
      });
    }
  } else if (action === "mvp1" || action === "mvp2") {
    if (!scrim.players.has(userId)) return interaction.reply({ content: "Only match players can vote.", ephemeral: true });
    scrim.mvpVotes.set(`${userId}-${action}`, interaction.values[0]);
    await interaction.reply({ content: `✅ Your MVP vote for <@${interaction.values[0]}> was recorded!`, ephemeral: true });
  } else if (action === "score") {
    if (scrim.host !== userId) return interaction.reply({ content: "Only the host can set the score.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`scrim_modal:score:${scrim.id}`).setTitle("Final Match Score");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("score").setLabel("Final Score (e.g. 13-5)").setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal);
  } else if (action === "finalize") {
    if (scrim.host !== userId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Only the host can finalize the match.", ephemeral: true });
    }
    await interaction.deferUpdate();

    // Tally MVPs
    const getMvp = (type) => {
      const votes = [...scrim.mvpVotes.entries()].filter(([k]) => k.endsWith(type)).map(([,v]) => v);
      if (votes.length === 0) return null;
      const counts = votes.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
      return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
    };

    const mvp1 = getMvp("mvp1");
    const mvp2 = getMvp("mvp2");

    let avg1 = 0; let avg2 = 0;
    const s = getScrimStats(interaction.guild.id, scrim.game);
    scrim.team1.forEach(u => avg1 += (s[u]?.elo ?? 1200));
    scrim.team2.forEach(u => avg2 += (s[u]?.elo ?? 1200));
    avg1 = avg1 / scrim.team1.length;
    avg2 = avg2 / scrim.team2.length;

    const t1Won = scrim.winner === "win1";
    const delta1 = calculateEloDelta(avg1, avg2, t1Won ? 1 : 0);
    const delta2 = calculateEloDelta(avg2, avg1, t1Won ? 0 : 1);

    const changes = [];
    const processTeam = (team, isWinner, delta, mvpId) => {
      for (const uid of team) {
        if (!s[uid]) s[uid] = { elo: 1200, wins: 0, losses: 0, mvps: 0 };
        s[uid].elo += delta;
        if (isWinner) s[uid].wins++; else s[uid].losses++;
        let isMvp = uid === mvpId;
        if (isMvp) s[uid].mvps = (s[uid].mvps || 0) + 1;
        changes.push(`<@${uid}>: **${s[uid].elo}** (${delta > 0 ? "+" : ""}${delta})${isMvp ? " 🌟 **(MVP)**" : ""}`);
      }
    };

    processTeam(scrim.team1, t1Won, delta1, mvp1);
    processTeam(scrim.team2, !t1Won, delta2, mvp2);

    updateScrimStats(interaction.guild.id, scrim.game, s);
    activeScrims.delete(id);

    const embed = successEmbed("Match Finalized", `**${t1Won ? "🔷 Team 1" : "🔶 Team 2"} Won!**\n**Final Score:** ${scrim.scoreStr}\n\n${changes.join("\n")}`);
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}
