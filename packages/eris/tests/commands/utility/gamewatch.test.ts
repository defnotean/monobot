import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../ai/gameWatcher.js", () => ({
  searchSteam: vi.fn(),
  addWatch: vi.fn(),
  removeWatch: vi.fn(),
  getWatches: vi.fn(),
}));

import { makeInteraction, makeChannel, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as gw from "../../../ai/gameWatcher.js";
import { execute } from "../../../commands/utility/gamewatch.js";

const m = gw as unknown as Record<string, ReturnType<typeof vi.fn>>;

function lastEdit(interaction: any) {
  // editReply pushes to _replies too; grab the last content/payload.
  return getLastReply(interaction);
}

describe("gamewatch command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects use in DMs (no guild)", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "list" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/only works in servers/i);
  });

  describe("add", () => {
    it("RSS path: defers, adds an RSS watch without searching Steam", async () => {
      m.addWatch.mockReturnValue("watch-1");
      const interaction: any = makeInteraction({
        subcommand: "add",
        options: { game: "MyGame", rss: "https://feed.example/rss" },
      });
      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalled();
      expect(m.searchSteam).not.toHaveBeenCalled();
      expect(m.addWatch).toHaveBeenCalledWith(interaction.guild.id, expect.objectContaining({
        gameName: "MyGame",
        rssUrl: "https://feed.example/rss",
        addedBy: interaction.user.id,
      }));
      expect(lastEdit(interaction)?.content).toMatch(/Now tracking \*\*MyGame\*\* via RSS/);
    });

    it("Steam path: reports when no results found", async () => {
      m.searchSteam.mockResolvedValue([]);
      const interaction: any = makeInteraction({
        subcommand: "add",
        options: { game: "Nonexistent" },
      });
      await execute(interaction);
      expect(m.addWatch).not.toHaveBeenCalled();
      expect(lastEdit(interaction)?.content).toMatch(/couldn't find \*\*Nonexistent\*\*/);
    });

    it("Steam path: prefers an exact-name match over the first result", async () => {
      m.searchSteam.mockResolvedValue([
        { id: 111, name: "Half-Life 2" },
        { id: 222, name: "Half-Life" },
      ]);
      m.addWatch.mockReturnValue("watch-2");
      const interaction: any = makeInteraction({
        subcommand: "add",
        options: { game: "Half-Life" },
        channel: makeChannel({ id: "chan-7" }),
      });
      await execute(interaction);
      // exact match is the second entry (id 222), not results[0].
      expect(m.addWatch).toHaveBeenCalledWith(interaction.guild.id, expect.objectContaining({
        gameName: "Half-Life",
        steamAppId: 222,
        channelId: "chan-7",
      }));
      const data = lastEdit(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/Now tracking: Half-Life/);
    });

    it("Steam path: falls back to first result and adds a disambiguation field", async () => {
      m.searchSteam.mockResolvedValue([
        { id: 1, name: "Portal Reloaded" },
        { id: 2, name: "Portal 2" },
        { id: 3, name: "Portal Stories" },
      ]);
      m.addWatch.mockReturnValue("watch-3");
      const interaction: any = makeInteraction({
        subcommand: "add",
        options: { game: "Portal" },
      });
      await execute(interaction);
      expect(m.addWatch).toHaveBeenCalledWith(interaction.guild.id, expect.objectContaining({ steamAppId: 1 }));
      const data = lastEdit(interaction)?.payload.embeds[0].data;
      const field = data.fields.find((f: any) => f.name === "Not the right game?");
      expect(field).toBeTruthy();
      expect(field.value).toMatch(/Portal 2/);
    });
  });

  describe("remove", () => {
    it("reports when the watch ID is unknown", async () => {
      m.getWatches.mockReturnValue([{ id: "abc", gameName: "X" }]);
      const interaction: any = makeInteraction({ subcommand: "remove", options: { id: "zzz" } });
      await execute(interaction);
      expect(m.removeWatch).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/no watch found with ID `zzz`/);
    });

    it("removes a known watch and confirms", async () => {
      m.getWatches.mockReturnValue([{ id: "abc", gameName: "Stardew" }]);
      const interaction: any = makeInteraction({ subcommand: "remove", options: { id: "abc" } });
      await execute(interaction);
      expect(m.removeWatch).toHaveBeenCalledWith(interaction.guild.id, "abc");
      expect(getLastReplyContent(interaction)).toMatch(/Stopped tracking \*\*Stardew\*\*/);
    });
  });

  describe("list", () => {
    it("reports when no watches exist", async () => {
      m.getWatches.mockReturnValue([]);
      const interaction: any = makeInteraction({ subcommand: "list" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no game watches set up yet/i);
    });

    it("lists watches in an embed, distinguishing Steam vs RSS sources", async () => {
      m.getWatches.mockReturnValue([
        { id: "a", gameName: "Terraria", channelId: "c1", steamAppId: 105600 },
        { id: "b", gameName: "Indie", channelId: "c2" },
      ]);
      const interaction: any = makeInteraction({ subcommand: "list" });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.description).toMatch(/Terraria/);
      expect(data.description).toMatch(/Steam `105600`/);
      expect(data.description).toMatch(/RSS/);
      expect(data.footer.text).toMatch(/2 active watches/);
    });
  });
});
