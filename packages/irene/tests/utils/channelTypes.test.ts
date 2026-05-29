import { describe, it, expect } from "vitest";
import { ChannelType } from "discord.js";

import { channelTypeLabel, isGuildCategory } from "../../utils/channelTypes.js";

describe("channelTypes helpers", () => {
  it("labels Discord channel types without raw magic numbers at call sites", () => {
    expect(channelTypeLabel(ChannelType.GuildVoice)).toBe("voice channel");
    expect(channelTypeLabel(ChannelType.GuildStageVoice)).toBe("stage channel");
    expect(channelTypeLabel(ChannelType.GuildCategory)).toBe("category");
    expect(channelTypeLabel(ChannelType.GuildForum)).toBe("forum channel");
    expect(channelTypeLabel(ChannelType.GuildAnnouncement)).toBe("announcement channel");
    expect(channelTypeLabel(ChannelType.GuildText)).toBe("text channel");
  });

  it("detects categories by named ChannelType", () => {
    expect(isGuildCategory({ type: ChannelType.GuildCategory })).toBe(true);
    expect(isGuildCategory({ type: ChannelType.GuildText })).toBe(false);
  });
});
