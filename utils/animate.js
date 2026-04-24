// ─── Animated Embed System ──────────────────────────────────────────────────
// Real animations with actual visual motion — spinning elements, progressive
// reveals, pulsing colors, cascading text, and frame-by-frame state changes.

import { EmbedBuilder } from "discord.js";

// ─── Core Animation Engine ──────────────────────────────────────────────────

export async function animateEmbed(channel, frames, delayMs = 900) {
  if (!frames?.length) return null;
  const msg = await channel.send({
    embeds: [frames[0].embed],
    components: frames[0].components || [],
  });
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, frames[i].delay || delayMs));
    await msg.edit({
      embeds: [frames[i].embed],
      components: frames[i].components || [],
    }).catch(() => {});
  }
  return msg;
}

export async function animateEmbedEdit(target, frames, delayMs = 900) {
  if (!frames?.length) return null;
  const isInteraction = typeof target.update === "function";
  if (isInteraction) {
    await target.update({ embeds: [frames[0].embed], components: frames[0].components || [] });
  } else {
    await target.edit({ embeds: [frames[0].embed], components: frames[0].components || [] }).catch(() => {});
  }
  const msg = isInteraction ? await target.fetchReply().catch(() => null) : target;
  if (!msg) return null;
  for (let i = 1; i < frames.length; i++) {
    await new Promise(r => setTimeout(r, frames[i].delay || delayMs));
    await msg.edit({ embeds: [frames[i].embed], components: frames[i].components || [] }).catch(() => {});
  }
  return msg;
}

// ─── Color Palette ──────────────────────────────────────────────────────────
const C = {
  DARK: 0x2b2d31,
  PURPLE: 0x7C3AED,
  GOLD: 0xFFD700,
  GREEN: 0x10B981,
  RED: 0xEF4444,
  BLUE: 0x6366F1,
  PINK: 0xEB459E,
  BLURPLE: 0x5865F2,
  LAVENDER: 0xE8C4F0,
  MIDNIGHT: 0x1a1a2e,
  WHITE: 0xffffff,
};

// ─── Spinner Characters ─────────────────────────────────────────────────────
const SPINNERS = {
  dots:    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  circle:  ["◐", "◓", "◑", "◒"],
  moon:    ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
  pulse:   ["░", "▒", "▓", "█", "▓", "▒"],
  star:    ["✦", "✧", "⊹", "˚", "⊹", "✧"],
  arrow:   ["▹▹▹▹▹", "▸▹▹▹▹", "▹▸▹▹▹", "▹▹▸▹▹", "▹▹▹▸▹", "▹▹▹▹▸"],
  bounce:  ["⠀⠀⠀●⠀⠀⠀", "⠀⠀●⠀⠀⠀⠀", "⠀●⠀⠀⠀⠀⠀", "●⠀⠀⠀⠀⠀⠀", "⠀●⠀⠀⠀⠀⠀", "⠀⠀●⠀⠀⠀⠀", "⠀⠀⠀●⠀⠀⠀", "⠀⠀⠀⠀●⠀⠀", "⠀⠀⠀⠀⠀●⠀", "⠀⠀⠀⠀⠀⠀●", "⠀⠀⠀⠀⠀●⠀", "⠀⠀⠀⠀●⠀⠀"],
  wave:    ["▁▂▃▄▅▆▇█▇▆", "▂▃▄▅▆▇█▇▆▅", "▃▄▅▆▇█▇▆▅▄", "▄▅▆▇█▇▆▅▄▃", "▅▆▇█▇▆▅▄▃▂", "▆▇█▇▆▅▄▃▂▁", "▇█▇▆▅▄▃▂▁▂", "█▇▆▅▄▃▂▁▂▃"],
};

// ─── Utility ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function obscure(text) {
  return text.replace(/[a-zA-Z0-9]/g, () => "░▒▓█"[Math.floor(Math.random() * 4)]);
}

// ─── Animation Builders ─────────────────────────────────────────────────────

/**
 * Typewriter — text appears line by line with a blinking cursor,
 * each line fading in with a scramble-to-clear effect.
 */
export function typewriterFrames(title, fullText, { color = C.DARK } = {}) {
  const clean = fullText.replace(/\\n/g, "\n");
  const lines = clean.split("\n");
  const frames = [];

  // Frame 1: empty with cursor
  frames.push({
    embed: new EmbedBuilder().setColor(color).setTitle(title).setDescription("▌"),
    delay: 700,
  });

  // Build up line by line
  let built = "";
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    if (!line.trim()) {
      built += "\n";
      continue;
    }
    // Scrambled version of this line
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(title).setDescription(built + obscure(line) + " ▌"),
      delay: 600,
    });
    // Clear version
    built += line + "\n";
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(title).setDescription(built.trimEnd() + " ▌"),
      delay: 500,
    });
  }

  // Final — no cursor
  frames.push({
    embed: new EmbedBuilder().setColor(color).setTitle(title).setDescription(clean),
    delay: 400,
  });

  // Cap at 8 frames max to stay under rate limits
  if (frames.length > 8) {
    const keep = [frames[0]];
    const step = (frames.length - 2) / 5;
    for (let i = 1; i <= 5; i++) keep.push(frames[Math.min(Math.floor(i * step), frames.length - 2)]);
    keep.push(frames[frames.length - 1]);
    return keep;
  }
  return frames;
}

/**
 * Progress bar — fills segment by segment with a moving wave effect
 * and percentage counter. Color shifts from purple to green.
 */
export function progressBarFrames(title, subtitle, { color = C.PURPLE, barLength = 20 } = {}) {
  const frames = [];
  const steps = [0, 15, 30, 50, 70, 85, 100];
  const colors = [C.DARK, color, color, C.BLUE, C.BLUE, C.GREEN, C.GREEN];
  const spinIdx = SPINNERS.dots;

  for (let s = 0; s < steps.length; s++) {
    const pct = steps[s];
    const filled = Math.round((pct / 100) * barLength);
    const empty = barLength - filled;
    // Wave effect on the leading edge
    const edge = pct < 100 && pct > 0 ? "▓" : "";
    const bar = "█".repeat(Math.max(0, filled - (edge ? 1 : 0))) + edge + "░".repeat(empty);
    const spinner = pct < 100 ? ` ${spinIdx[s % spinIdx.length]}` : " ✅";
    const sub = subtitle ? `${subtitle}\n\n` : "";
    const desc = `${sub}\`${bar}\` **${pct}%**${spinner}`;
    frames.push({
      embed: new EmbedBuilder().setColor(colors[s]).setTitle(title).setDescription(desc),
      delay: pct === 100 ? 600 : 800,
    });
  }
  return frames;
}

/**
 * Countdown — large numbers with pulsing border effects,
 * shaking visual on each number change, explosive finale.
 */
export function countdownFrames(from = 3, endTitle = "GO!", { color = C.PURPLE, endColor = C.GOLD, subtitle = "" } = {}) {
  const frames = [];
  const sub = subtitle ? `\n\n${subtitle}` : "";
  const borders = ["── ⊹ ──", "━━ ✦ ━━", "── ⟡ ──", "━━ ⊹ ━━"];

  for (let i = from; i >= 1; i--) {
    // Calm frame
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`⏱️ countdown`).setDescription(`${borders[i % borders.length]}\n\n# ${i}\n\n${borders[(i + 2) % borders.length]}${sub}`),
      delay: 500,
    });
    // Pulse frame — color flash
    frames.push({
      embed: new EmbedBuilder().setColor(i <= 1 ? C.RED : C.DARK).setTitle(`⏱️ countdown`).setDescription(`${borders[(i + 1) % borders.length]}\n\n# **${i}**\n\n${borders[(i + 3) % borders.length]}${sub}`),
      delay: 500,
    });
  }

  // Finale — explosive
  frames.push({
    embed: new EmbedBuilder().setColor(endColor).setTitle(`✦ ${endTitle} ✦`).setDescription(`━━━━━━━━━━━━━━━━━━\n\n# ✨ ${endTitle} ✨\n\n━━━━━━━━━━━━━━━━━━${sub}`),
    delay: 800,
  });
  return frames;
}

/**
 * Reveal — text is encrypted/scrambled then progressively decrypts
 * character by character across multiple frames.
 */
export function revealFrames(title, revealText, { color = C.DARK, revealColor = C.GOLD } = {}) {
  const clean = revealText.replace(/\\n/g, "\n");
  const frames = [];
  const chars = [...clean];
  const total = chars.filter(c => /[a-zA-Z0-9]/.test(c)).length;

  // Frame 1: fully encrypted
  frames.push({
    embed: new EmbedBuilder().setColor(C.MIDNIGHT).setTitle(`🔒 ${title}`).setDescription(`\`\`\`\n${obscure(clean)}\n\`\`\``),
    delay: 1000,
  });

  // Frame 2: partially decrypted (30%)
  const partial1 = [...clean].map((ch, i) => /[a-zA-Z0-9]/.test(ch) && Math.random() > 0.3 ? "░▒▓"[Math.floor(Math.random() * 3)] : ch).join("");
  frames.push({
    embed: new EmbedBuilder().setColor(C.PURPLE).setTitle(`🔓 ${title}`).setDescription(`\`\`\`\n${partial1}\n\`\`\``),
    delay: 800,
  });

  // Frame 3: mostly decrypted (70%)
  const partial2 = [...clean].map((ch, i) => /[a-zA-Z0-9]/.test(ch) && Math.random() > 0.7 ? "▓"  : ch).join("");
  frames.push({
    embed: new EmbedBuilder().setColor(C.BLUE).setTitle(`🔓 ${title}`).setDescription(`\`\`\`\n${partial2}\n\`\`\``),
    delay: 800,
  });

  // Frame 4: glitch frame — flash
  frames.push({
    embed: new EmbedBuilder().setColor(C.WHITE).setTitle(`⚡ ${title}`).setDescription("█".repeat(20)),
    delay: 300,
  });

  // Frame 5: fully revealed
  frames.push({
    embed: new EmbedBuilder().setColor(revealColor || C.GOLD).setTitle(`✨ ${title}`).setDescription(clean),
    delay: 800,
  });

  return frames;
}

/**
 * Loading — spinning dot animation with wave visualizer,
 * cycles through multiple spinner styles.
 */
export function loadingFrames(title, { color = C.DARK } = {}) {
  const frames = [];
  const waves = SPINNERS.wave;
  const dots = SPINNERS.dots;

  for (let i = 0; i < 6; i++) {
    const wave = waves[i % waves.length];
    const dot = dots[i % dots.length];
    const trail = "⠀".repeat(i % 3) + "✦" + "⠀".repeat(2 - (i % 3));
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`${dot} ${title}`).setDescription(`\`${wave}\`\n\n${trail}`),
      delay: 700,
    });
  }
  return frames;
}

/**
 * Sparkle entrance — embed forms from scattered particles,
 * coalescing into the final content through 6 frames.
 */
export function sparkleFrames(title, finalDescription, { color = C.DARK, finalColor = null } = {}) {
  const clean = finalDescription.replace(/\\n/g, "\n");
  const particles = ["✦", "✧", "⊹", "˚", "⟡", "˖", "·"];
  const scatter = (density) => {
    let out = "";
    for (let i = 0; i < density; i++) out += particles[Math.floor(Math.random() * particles.length)] + " ";
    return out.trim();
  };

  return [
    // Particles scattered
    { embed: new EmbedBuilder().setColor(C.MIDNIGHT).setDescription(`\n${scatter(8)}\n\n${scatter(6)}\n\n${scatter(8)}\n`), delay: 600 },
    // Particles gathering
    { embed: new EmbedBuilder().setColor(C.DARK).setDescription(`\n⠀⠀${scatter(4)}\n\n⠀⠀⠀${scatter(3)}\n\n⠀⠀${scatter(4)}\n`), delay: 600 },
    // Form title shape
    { embed: new EmbedBuilder().setColor(color).setTitle(`${scatter(3)}`).setDescription(`── ⊹ ──\n\n${scatter(5)}\n\n── ⊹ ──`), delay: 600 },
    // Title solidifies, content still forming
    { embed: new EmbedBuilder().setColor(color).setTitle(`✦ ${title} ✦`).setDescription(`── ⊹ ──\n\n${obscure(clean.substring(0, 60))}\n\n── ⊹ ──`), delay: 700 },
    // Almost there — content clearing
    { embed: new EmbedBuilder().setColor(color).setTitle(`✦ ${title} ✦`).setDescription(`━━━━━━━━━━━━━━━\n\n${clean}\n\n━━━━━━━━━━━━━━━`), delay: 500 },
    // Final clean version
    { embed: new EmbedBuilder().setColor(finalColor || color).setTitle(title).setDescription(clean), delay: 800 },
  ];
}

/**
 * Status update — each step has a spinner while active,
 * then gets checked off with a visual state change.
 */
export function statusFrames(title, steps, { color = C.PURPLE, doneColor = C.GREEN } = {}) {
  const frames = [];
  const dots = SPINNERS.dots;

  for (let i = 0; i < steps.length; i++) {
    // Spinner frame for current step
    const spinLines = steps.map((s, j) => {
      if (j < i) return `✅ ~~${s}~~`;
      if (j === i) return `${dots[0]} **${s}...**`;
      return `⬜ ${s}`;
    });
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`⚙️ ${title}`).setDescription(spinLines.join("\n")),
      delay: 800,
    });

    // Completing frame — spinner cycles then checks
    const doneLines = steps.map((s, j) => {
      if (j < i) return `✅ ~~${s}~~`;
      if (j === i) return `${dots[4]} **${s}...**`;
      return `⬜ ${s}`;
    });
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`⚙️ ${title}`).setDescription(doneLines.join("\n")),
      delay: 600,
    });
  }

  // Final — all done with celebration
  const allDone = steps.map(s => `✅ ~~${s}~~`);
  frames.push({
    embed: new EmbedBuilder().setColor(doneColor).setTitle(`✅ ${title}`).setDescription(allDone.join("\n") + "\n\n-# ✦ all done"),
    delay: 800,
  });

  // Cap at 9 frames
  if (frames.length > 9) {
    const keep = [frames[0]];
    const step = (frames.length - 2) / 6;
    for (let i = 1; i <= 6; i++) keep.push(frames[Math.min(Math.floor(i * step), frames.length - 2)]);
    keep.push(frames[frames.length - 1]);
    return keep;
  }
  return frames;
}

/**
 * Giveaway winner reveal — slot-machine style name scramble
 * that cycles through fake names before landing on the winner.
 */
export function giveawayRevealFrames(prize, winnerMention, { color = C.PINK } = {}) {
  const fakeNames = shuffle(["@someone", "@user", "@player", "@winner", "@lucky", "@chosen", "@mystery"]);
  const sparkles = ["✨", "💫", "⭐", "🌟", "✦"];

  return [
    // Initial
    { embed: new EmbedBuilder().setColor(C.DARK).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ⊹ ──\n\n⏳ selecting winner...\n\n── ⊹ ──`), delay: 1000 },
    // Scramble through names
    { embed: new EmbedBuilder().setColor(C.PURPLE).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ✦ ──\n\n🎯 ~~${fakeNames[0]}~~\n\n── ✦ ──`), delay: 600 },
    { embed: new EmbedBuilder().setColor(C.BLUE).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ✦ ──\n\n🎯 ~~${fakeNames[1]}~~\n\n── ✦ ──`), delay: 500 },
    { embed: new EmbedBuilder().setColor(C.PURPLE).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ✦ ──\n\n🎯 ~~${fakeNames[2]}~~\n\n── ✦ ──`), delay: 400 },
    { embed: new EmbedBuilder().setColor(C.BLUE).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ⟡ ──\n\n🎯 ~~${fakeNames[3]}~~\n\n── ⟡ ──`), delay: 400 },
    // Slowdown
    { embed: new EmbedBuilder().setColor(C.LAVENDER).setTitle("🎉 Giveaway").setDescription(`**${prize}**\n\n── ⟡ ──\n\n🎯 ~~${fakeNames[4]}~~\n\n── ⟡ ──`), delay: 600 },
    // Flash
    { embed: new EmbedBuilder().setColor(C.WHITE).setTitle("✨").setDescription("━━━━━━━━━━━━━━━━━━"), delay: 300 },
    // Winner!
    { embed: new EmbedBuilder().setColor(C.GOLD).setTitle("🎊 WINNER 🎊").setDescription(`**${prize}**\n\n━━━━━━━━━━━━━━━━━━\n\n${sparkles[Math.floor(Math.random() * sparkles.length)]} ${winnerMention} ${sparkles[Math.floor(Math.random() * sparkles.length)]}\n\n━━━━━━━━━━━━━━━━━━\n\n-# congratulations!`), delay: 800 },
  ];
}

/**
 * Poll results — bars fill in one by one from top to bottom,
 * each bar animating from empty to its final width.
 */
export function pollResultFrames(question, options, { color = C.BLURPLE, barLength = 15 } = {}) {
  const total = options.reduce((a, o) => a + o.votes, 0) || 1;
  const sorted = [...options].sort((a, b) => b.votes - a.votes);
  const frames = [];

  const makeLine = (o, filled, showCount) => {
    const pct = Math.round((o.votes / total) * 100);
    const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
    const emoji = o.emoji ? `${o.emoji} ` : "";
    return `${emoji}**${o.name}**\n\`${bar}\` ${showCount ? `**${pct}%** (${o.votes})` : ""}`;
  };

  // Frame 1: all empty
  const emptyLines = sorted.map(o => makeLine(o, 0, false));
  frames.push({
    embed: new EmbedBuilder().setColor(C.DARK).setTitle(`📊 ${question}`).setDescription(emptyLines.join("\n\n")),
    delay: 800,
  });

  // Fill each bar one at a time
  const finalFills = sorted.map(o => Math.round((o.votes / total) * barLength));
  for (let barIdx = 0; barIdx < Math.min(sorted.length, 4); barIdx++) {
    // Half-filled
    const halfLines = sorted.map((o, j) => {
      if (j < barIdx) return makeLine(o, finalFills[j], true);
      if (j === barIdx) return makeLine(o, Math.floor(finalFills[j] / 2), false);
      return makeLine(o, 0, false);
    });
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`📊 ${question}`).setDescription(halfLines.join("\n\n")),
      delay: 500,
    });

    // Full bar
    const fullLines = sorted.map((o, j) => {
      if (j <= barIdx) return makeLine(o, finalFills[j], true);
      return makeLine(o, 0, false);
    });
    frames.push({
      embed: new EmbedBuilder().setColor(color).setTitle(`📊 ${question}`).setDescription(fullLines.join("\n\n")),
      delay: 600,
    });
  }

  // Final with crown on winner
  const finalLines = sorted.map((o, i) => {
    const pct = Math.round((o.votes / total) * 100);
    const bar = "█".repeat(finalFills[i]) + "░".repeat(barLength - finalFills[i]);
    const emoji = o.emoji ? `${o.emoji} ` : "";
    const crown = i === 0 ? " 👑" : "";
    return `${emoji}**${o.name}**${crown}\n\`${bar}\` **${pct}%** (${o.votes})`;
  });
  frames.push({
    embed: new EmbedBuilder().setColor(C.GOLD).setTitle(`📊 ${question}`).setDescription(finalLines.join("\n\n")).setFooter({ text: `${total} total votes` }),
    delay: 800,
  });

  // Cap at 9 frames
  if (frames.length > 9) {
    const keep = [frames[0]];
    const step = (frames.length - 2) / 6;
    for (let i = 1; i <= 6; i++) keep.push(frames[Math.min(Math.floor(i * step), frames.length - 2)]);
    keep.push(frames[frames.length - 1]);
    return keep;
  }
  return frames;
}

/**
 * Alert — pulsing red/dark flash with shaking border,
 * content reveals dramatically.
 */
export function alertFrames(title, body, { color = C.RED } = {}) {
  const clean = body.replace(/\\n/g, "\n");
  return [
    // Dark
    { embed: new EmbedBuilder().setColor(C.DARK).setDescription("⠀"), delay: 500 },
    // Flash red
    { embed: new EmbedBuilder().setColor(color).setTitle("⚠️").setDescription("━━━━━━━━━━━━━━━━━━"), delay: 400 },
    // Dark again
    { embed: new EmbedBuilder().setColor(C.DARK).setTitle("⚠️").setDescription("━━━━━━━━━━━━━━━━━━"), delay: 400 },
    // Flash red with title
    { embed: new EmbedBuilder().setColor(color).setTitle(`⚠️ ${title}`).setDescription("━━━━━━━━━━━━━━━━━━"), delay: 400 },
    // Pulse dark
    { embed: new EmbedBuilder().setColor(C.DARK).setTitle(`⚠️ ${title}`).setDescription("━━━━━━━━━━━━━━━━━━\n\n▓▓▓▓▓▓▓▓▓▓\n\n━━━━━━━━━━━━━━━━━━"), delay: 400 },
    // Final — content revealed
    { embed: new EmbedBuilder().setColor(color).setTitle(`⚠️ ${title}`).setDescription(`━━━━━━━━━━━━━━━━━━\n\n${clean}\n\n━━━━━━━━━━━━━━━━━━`), delay: 800 },
  ];
}

// ─── Animation Type Registry ────────────────────────────────────────────────
export const ANIMATION_TYPES = {
  typewriter: { fn: typewriterFrames, description: "Text decrypts line by line with cursor" },
  progress: { fn: progressBarFrames, description: "Progress bar fills with wave effect" },
  countdown: { fn: countdownFrames, description: "Pulsing countdown with explosive finale" },
  reveal: { fn: revealFrames, description: "Encrypted text decrypts into clear message" },
  loading: { fn: loadingFrames, description: "Wave visualizer with spinning dots" },
  sparkle: { fn: sparkleFrames, description: "Particles scatter then coalesce into embed" },
  status: { fn: statusFrames, description: "Steps with spinners that check off one by one" },
  giveaway: { fn: giveawayRevealFrames, description: "Slot-machine name scramble to winner reveal" },
  poll_results: { fn: pollResultFrames, description: "Bars fill in one by one with counts" },
  alert: { fn: alertFrames, description: "Pulsing red/dark flash with dramatic content reveal" },
};
