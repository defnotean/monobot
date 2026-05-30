// ─── Test / Dev Executor ────────────────────────────────────────────────────
//
// Admin-facing "fire a test event into this channel" tools — patch-news preview,
// test birthday announcement, test welcome message. They reuse the same embed
// builders the real scheduled events use, so a preview matches production.

import { getGuildSettings, getWelcomeEmbed } from "../../database.js";
import { buildWelcomeEmbed } from "../../events/guildMemberAdd.js";

const HANDLED = new Set([
  "test_patch_news", "send_test_birthday", "send_test_welcome",
]);

export async function execute(toolName, input, message, ctx) {
  if (!HANDLED.has(toolName)) return undefined;

  const { guild } = ctx;

  switch (toolName) {
    case "test_patch_news": {
      const { fetchLatestPost, KNOWN_FEEDS: feeds } = await import("../../utils/patchbot.js");
      const raw = input.feed?.toLowerCase().trim();

      const known = feeds[raw];
      if (!known && !raw?.startsWith("http")) {
        return `unknown feed "${input.feed}" — available: ${Object.keys(feeds).join(", ")}`;
      }

      const feedUrl = known?.url ?? known?.listingUrl ?? raw;
      const feedName = known?.name ?? "Custom Feed";
      const feedColor = known?.color ?? 0x5865F2;

      const offset = input.offset ?? 0;
      const search = input.search ?? null;

      try {
        const result = await fetchLatestPost(feedUrl, feedName, feedColor, { offset, search });
        if (!result) return `no posts found for ${feedName}`;
        if (result.notFound) {
          const list = result.available?.slice(0, 6).map((t, i) => `${i}. ${t}`).join("\n") ?? "none";
          return `couldn't find that specific patch. available patches:\n${list}`;
        }
        await message.channel.send({ embeds: [result.embed], components: result.components });
        return `posted ${feedName} update: "${result.title}"`;
      } catch (err) {
        return `failed to fetch ${feedName}: ${err.message}`;
      }
    }

    case "send_test_birthday": {
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return "Couldn't resolve your guild member — try again in the server.";
      const { buildBirthdayEmbed } = await import("../../utils/birthday.js");
      const { getBirthdayConfig: getBdayConfig, getBirthday: getBdayRecord } = await import("../../database.js");
      const bdayConfig = getBdayConfig(guild.id);
      const bdayRecord = getBdayRecord(message.author.id, guild.id);
      const { embed, pingContent } = buildBirthdayEmbed(member, bdayConfig, bdayRecord);
      await message.channel.send({ content: `${pingContent} *(test birthday announcement)*`, embeds: [embed] });
      return "Test birthday announcement sent!";
    }

    case "send_test_welcome": {
      const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return "Couldn't resolve your guild member — try again in the server.";

      const settings = getGuildSettings(guild.id);
      const embedCfg = getWelcomeEmbed(guild.id);
      const { embed, pingContent } = buildWelcomeEmbed(member, settings, embedCfg);

      await message.channel.send({ content: `${pingContent || member.toString()} *(test welcome)*`, embeds: [embed] });
      return "Test welcome message sent!";
    }
  }
}
