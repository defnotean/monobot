import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle , MessageFlags } from "discord.js";

const STEPS = [
  {
    title: "👋 Welcome to Eris",
    description: "hey, im eris. im not your typical bot — i remember things, i have moods, and i run a whole economy. let me show you around",
    color: 0x9333EA,
  },
  {
    title: "💬 How to Talk to Me",
    description: "just @ me or reply to my messages. no slash commands needed for most things — i understand natural language.\n\ntry saying: \"hey eris, whats up\" or \"tell me something interesting\"",
    color: 0x9333EA,
  },
  {
    title: "🧠 I Remember Things",
    description: "i remember what you tell me — your name, what you like, inside jokes. ask me \"what do you know about me\" anytime.\n\ni keep secrets too. if you tell me something sensitive, ill never share it with anyone else",
    color: 0x9333EA,
  },
  {
    title: "💰 Economy Basics",
    description: "you start with **100 coins**. here's how to get more:\n\n• `/daily` — free coins every day (streak bonus!)\n• `/fish` `/hunt` `/dig` — grind activities (30-45s cooldowns)\n• `/work` — random job, 50-200 coins (30min cooldown)\n• `/weekly` `/monthly` — bigger rewards, longer cooldowns\n\ncheck your balance with `/balance`",
    color: 0x10B981,
  },
  {
    title: "🎰 Gambling",
    description: "feeling lucky? try your coins:\n\n• `/coinflip [amount]` — double or nothing\n• `/slots [amount]` — spin for 1.5x to 10x\n• `/dice [amount] [guess]` — guess the roll for 5x\n\n*psst... my mood affects the odds. be nice to me* 😏",
    color: 0xF59E0B,
  },
  {
    title: "🛒 Shop & Items",
    description: "use `/shop` to browse. highlights:\n\n• **Equipment** — Fishing Rod, Hunting Rifle boost grinding\n• **Protections** — Rob Shield, Bodyguard keep you safe\n• **Minions** — passive income while you're offline\n• **Upgrades** — permanent bonuses to earnings\n\nsay \"buy fishing rod\" to purchase",
    color: 0x6366F1,
  },
  {
    title: "🐾 Pets & Marriage",
    description: "• `/pet adopt [name] [species]` — adopt a pet\n• `/pet train [stat]` — make it stronger\n• `/pet feed` — keep it happy\n• pet battles against other players!\n\n💍 `/marry @someone` — +10% coin bonus for both of you",
    color: 0xEF4444,
  },
  {
    title: "🚀 Advanced Features",
    description: "theres SO much more:\n\n• 📈 **Stocks** — buy/sell fake crypto\n• 🏴‍☠️ **Heists** — team up to rob someone\n• 🗺️ **Territories** — claim channels for income\n• ⚔️ **Duels** — 1v1 coin battles\n• 🎯 **Boss Battles** — server-wide events\n• 🏗️ **Crafting** — combine items\n• 🎮 **Trivia/Scramble** — brain games for coins",
    color: 0x9333EA,
  },
  {
    title: "⌨️ Quick Reference",
    description: "**slash commands:** /balance, /daily, /weekly, /monthly, /shop, /fish, /hunt, /dig, /work, /coinflip, /slots, /dice, /pet, /bank, /leaderboard, /inventory\n\n**or just talk to me naturally** — \"flip 50\", \"how many coins do i have\", \"adopt a pet named bob\"\n\nhonestly just talk to me, its more fun that way 💜",
    color: 0x9333EA,
  },
];

function buildStep(step, index) {
  const embed = new EmbedBuilder()
    .setTitle(step.title)
    .setDescription(step.description)
    .setColor(step.color)
    .setFooter({ text: `Step ${index + 1} of ${STEPS.length}` });

  const row = new ActionRowBuilder();

  if (index > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`tutorial_${index}_back`).setLabel("← Back").setStyle(ButtonStyle.Secondary)
    );
  }

  if (index < STEPS.length - 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`tutorial_${index}_next`).setLabel("Next →").setStyle(ButtonStyle.Primary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId(`tutorial_${index}_done`).setLabel("Done ✓").setStyle(ButtonStyle.Success)
    );
  }

  row.addComponents(
    new ButtonBuilder().setCustomId(`tutorial_${index}_skip`).setLabel("Skip").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export const data = new SlashCommandBuilder()
  .setName("tutorial")
  .setDescription("Learn what Eris can do — interactive walkthrough");

export async function execute(interaction) {
  const response = buildStep(STEPS[0], 0);
  await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
}

// Export for button handling in interactionCreate
export { STEPS, buildStep };
