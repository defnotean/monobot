// ─── Birthday Executor ──────────────────────────────────────────────────────
//
// Per-user birthday records (set/get/list/remove) plus server birthday
// announcement config (configure_birthdays). Date validation lives here so a
// hallucinated Feb 30 / non-leap-year Feb 29 can't be stored.

import { setBirthdayChannel, setBirthdayRole, setBirthdayMessage } from "../../database.js";

const HANDLED = new Set([
  "set_birthday", "get_birthday", "list_birthdays",
  "remove_birthday", "configure_birthdays",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild, findMember, findChannel, findRole } = ctx;

  switch (toolName) {
    case "set_birthday": {
      const { setBirthday } = await import("../../database.js");
      let targetId = message.author.id;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
      }
      const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const m = Math.floor(input.month);
      const d = Math.floor(input.day);
      const y = input.year ? Math.floor(input.year) : null;
      if (m < 1 || m > 12) return "Month must be 1–12.";
      if (d < 1 || d > DAYS_IN_MONTH[m]) return `${MONTHS[m]} only has ${DAYS_IN_MONTH[m]} days.`;
      if (m === 2 && d === 29 && y) {
        const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
        if (!isLeap) return `${y} wasn't a leap year — Feb only had 28 days`;
      }
      if (y && (y < 1900 || y > new Date().getFullYear())) return `Year ${y} doesn't seem right.`;
      setBirthday(targetId, guild.id, m, d, y);
      const who = targetId === message.author.id ? "Your" : `<@${targetId}>'s`;
      const dateStr = y ? `**${MONTHS[m]} ${d}, ${y}**` : `**${MONTHS[m]} ${d}**`;
      let extra = "";
      if (y) {
        const today = new Date();
        let age = today.getFullYear() - y;
        if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
        extra += ` (currently ${age} years old, turning ${age + 1} on their next birthday)`;
      }
      const today = new Date();
      const nextBday = new Date(today.getFullYear(), m - 1, d);
      if (nextBday <= today) nextBday.setFullYear(today.getFullYear() + 1);
      const daysUntil = Math.ceil((nextBday.getTime() - today.getTime()) / 86_400_000);
      if (daysUntil === 0) extra += " — that's today! 🎉";
      else if (daysUntil === 1) extra += " — that's tomorrow!";
      else extra += ` — ${daysUntil} days away`;
      return `${who} birthday has been saved as ${dateStr}${extra} 🎂`;
    }

    case "get_birthday": {
      const { getBirthday: getBday } = await import("../../database.js");
      let targetId = message.author.id;
      let targetName = message.author.username;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
        targetName = member.displayName;
      }
      const bday = getBday(targetId, guild.id);
      if (!bday) return targetId === message.author.id ? "You haven't set your birthday yet. Tell me your birthday and I'll remember it!" : `${targetName} hasn't set their birthday yet.`;
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const dateStr = bday.year ? `**${MONTHS[bday.month]} ${bday.day}, ${bday.year}**` : `**${MONTHS[bday.month]} ${bday.day}**`;
      const today = new Date();
      let ageInfo = "";
      if (bday.year) {
        let age = today.getFullYear() - bday.year;
        if (today.getMonth() + 1 < bday.month || (today.getMonth() + 1 === bday.month && today.getDate() < bday.day)) age--;
        ageInfo = ` — currently ${age} years old, turning ${age + 1}`;
      }
      const nextBday = new Date(today.getFullYear(), bday.month - 1, bday.day);
      if (nextBday <= today) nextBday.setFullYear(today.getFullYear() + 1);
      const daysUntil = Math.ceil((nextBday.getTime() - today.getTime()) / 86_400_000);
      const countdown = daysUntil === 0 ? " — that's TODAY! 🎉" : daysUntil === 1 ? " — that's TOMORROW!" : ` — ${daysUntil} days away`;
      return `${targetName}'s birthday is ${dateStr}${ageInfo}${countdown} 🎂`;
    }

    case "list_birthdays": {
      const { getGuildBirthdays } = await import("../../database.js");
      const all = getGuildBirthdays(guild.id);
      if (!all.length) return "No birthdays registered in this server yet.";
      const MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
      const today = new Date();
      function daysUntil(month, day) {
        const bDate = new Date(today.getFullYear(), month - 1, day);
        if (bDate < today) bDate.setFullYear(today.getFullYear() + 1);
        return Math.ceil((bDate.getTime() - today.getTime()) / 86_400_000);
      }
      const sorted = [...all].sort((a, b) => daysUntil(a.month, a.day) - daysUntil(b.month, b.day));
      const lines = sorted.slice(0, 20).map((b) => {
        const member = guild.members.cache.get(b.userId);
        const name = member?.displayName ?? `<@${b.userId}>`;
        const days = daysUntil(b.month, b.day);
        const when = days === 0 ? "🎉 today!" : days === 1 ? "tomorrow" : `in ${days}d`;
        let turningStr = "";
        if (b.year) {
          const nextBirthday = new Date(today.getFullYear(), b.month - 1, b.day);
          if (nextBirthday < today) nextBirthday.setFullYear(today.getFullYear() + 1);
          const turningAge = nextBirthday.getFullYear() - b.year;
          turningStr = ` — turning ${turningAge}`;
        }
        return `**${name}** — ${MONTHS[b.month]} ${b.day}${b.year ? `, ${b.year}` : ""} (${when}${turningStr})`;
      });
      return `🎂 Upcoming birthdays:\n${lines.join("\n")}`;
    }

    case "remove_birthday": {
      const { removeBirthday: rmBday } = await import("../../database.js");
      let targetId = message.author.id;
      if (input.username) {
        const member = findMember(guild, input.username);
        if (!member) return `Couldn't find user "${input.username}"`;
        targetId = member.id;
      }
      const removed = rmBday(targetId, guild.id);
      return removed ? "Birthday removed ✓" : "No birthday was set for that user.";
    }

    case "configure_birthdays": {
      if (input.disable) {
        setBirthdayChannel(guild.id, null);
        return "Birthday announcements disabled.";
      }
      if (!input.channel_name) return "Please provide a channel name.";
      const channel = findChannel(guild, input.channel_id || input.channel_name);
      if (!channel) return `Channel #${input.channel_name} not found`;
      setBirthdayChannel(guild.id, channel.id);
      const parts = [`Birthday channel set to #${channel.name}`];
      if (input.role_name) {
        const role = findRole(guild, input.role_name);
        if (role) { setBirthdayRole(guild.id, role.id); parts.push(`Birthday role: @${role.name} (24 h)`); }
        else parts.push(`Role "${input.role_name}" not found — skipped`);
      }
      if (input.message) {
        setBirthdayMessage(guild.id, input.message === "default" ? null : input.message);
        parts.push("Custom message saved");
      }
      return parts.join("\n");
    }
  }
}
