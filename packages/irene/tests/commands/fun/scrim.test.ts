// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

// scrims.js (the real util) builds discord.js component rows in buildLobbyEmbed
// and registers a setInterval at import; we mock it so the test drives a
// controllable activeScrims Map + a lightweight buildLobbyEmbed stub and asserts
// what the command stores, without depending on discord.js builder internals.
const scrims = vi.hoisted(() => {
  const activeScrims = new Map();
  return {
    activeScrims,
    buildLobbyEmbed: vi.fn((scrim) => ({
      embeds: [{ data: { title: `${scrim.game} Scrim Lobby`, description: `Host: <@${scrim.host}>` } }],
      components: [],
    })),
  };
});
vi.mock("../../../utils/scrims.js", () => scrims);

const db = vi.hoisted(() => ({ getScrimStats: vi.fn() }));
vi.mock("../../../database.js", () => db);

// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/scrim.js";

beforeEach(() => {
  db.getScrimStats.mockReset();
  scrims.activeScrims.clear();
  scrims.buildLobbyEmbed.mockClear();
});

describe("fun/scrim", () => {
  it("declares create/leaderboard/stats subcommands", () => {
    const json = cmd.data.toJSON();
    const names = json.options.map((o: any) => o.name).sort();
    expect(names).toEqual(["create", "leaderboard", "stats"]);
  });

  describe("create", () => {
    it("registers an active scrim lobby keyed by interaction id with the host enrolled", async () => {
      const user = makeUser({ id: "host-1" });
      const interaction = makeInteraction({ user, subcommand: "create", options: { game: "Valorant", team_size: 3 } });
      await cmd.execute(interaction);

      const scrim = scrims.activeScrims.get(interaction.id);
      expect(scrim).toBeTruthy();
      expect(scrim.game).toBe("Valorant");
      expect(scrim.teamSize).toBe(3);
      expect(scrim.host).toBe("host-1");
      expect(scrim.players.has("host-1")).toBe(true);
      expect(scrim.status).toBe("lobby");
      // The command must build the lobby embed from the freshly-stored scrim
      // and reply with it.
      expect(scrims.buildLobbyEmbed).toHaveBeenCalledWith(scrim);
      expect(repliedText(interaction)).toContain("Valorant Scrim Lobby");
    });

    it("defaults team size to 5 when not provided", async () => {
      const interaction = makeInteraction({ subcommand: "create", options: { game: "League" } });
      await cmd.execute(interaction);
      expect(scrims.activeScrims.get(interaction.id).teamSize).toBe(5);
    });
  });

  describe("leaderboard", () => {
    it("shows a No Data error when no matches exist for the game", async () => {
      db.getScrimStats.mockReturnValue({});
      const interaction = makeInteraction({ subcommand: "leaderboard", options: { game: "Dota" } });
      await cmd.execute(interaction);
      const text = repliedText(interaction);
      expect(text).toContain("No Data");
      expect(text).toContain("Dota");
    });

    it("ranks players by ELO descending and caps at top 10", async () => {
      const stats: Record<string, any> = {};
      for (let i = 0; i < 12; i++) {
        stats[`p${i}`] = { elo: 1000 + i, wins: i, losses: 1, mvps: 0 };
      }
      db.getScrimStats.mockReturnValue(stats);
      const interaction = makeInteraction({ subcommand: "leaderboard", options: { game: "Valorant" } });
      await cmd.execute(interaction);

      const desc = lastReply(interaction).embeds[0].data.description;
      // Highest ELO (p11=1011) must be #1; lowest two (p0,p1) excluded by top-10 cap.
      expect(desc).toContain("**#1** <@p11>");
      expect(desc).toContain("1011 ELO");
      expect(desc).not.toContain("<@p0>");
    });
  });

  describe("stats", () => {
    it("shows No Stats when the target has not played the game", async () => {
      db.getScrimStats.mockReturnValue({});
      const target = makeUser({ id: "noob" });
      const interaction = makeInteraction({ subcommand: "stats", options: { game: "Valorant", player: target } });
      await cmd.execute(interaction);
      expect(repliedText(interaction)).toContain("No Stats");
    });

    it("computes win rate and surfaces ELO for a player with history", async () => {
      const target = makeUser({ id: "pro", username: "pro" });
      db.getScrimStats.mockReturnValue({ pro: { elo: 1500, wins: 3, losses: 1, mvps: 2 } });
      const interaction = makeInteraction({ subcommand: "stats", options: { game: "Valorant", player: target } });
      await cmd.execute(interaction);

      const fields = lastReply(interaction).embeds[0].data.fields;
      expect(fields.find((f: any) => f.name === "ELO Rating").value).toBe("**1500**");
      // 3 wins / 4 matches = 75%.
      expect(fields.find((f: any) => f.name === "Win Rate").value).toContain("75%");
      expect(fields.find((f: any) => f.name === "MVP Awards").value).toContain("2");
    });

    it("defaults the target to the caller when no player option is supplied", async () => {
      const caller = makeUser({ id: "self" });
      db.getScrimStats.mockReturnValue({ self: { elo: 1200, wins: 0, losses: 0, mvps: 0 } });
      const interaction = makeInteraction({ subcommand: "stats", options: { game: "Valorant" }, user: caller });
      await cmd.execute(interaction);
      // 0 matches -> 0% win rate branch.
      const fields = lastReply(interaction).embeds[0].data.fields;
      expect(fields.find((f: any) => f.name === "Win Rate").value).toContain("0%");
    });
  });
});
