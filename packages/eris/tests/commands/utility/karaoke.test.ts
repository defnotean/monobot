import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../ai/karaoke.js", () => ({
  isIrene: vi.fn(),
  startKaraoke: vi.fn(),
  stopKaraoke: vi.fn(),
  pauseKaraoke: vi.fn(),
  resumeKaraoke: vi.fn(),
  setOffset: vi.fn(),
  getStatus: vi.fn(),
  startAutoMode: vi.fn(),
}));

vi.mock("../../../lastfm/db.js", () => ({
  getFmUser: vi.fn(),
}));

import { makeInteraction, getLastReply, getLastReplyContent } from "../../_helpers/mockDiscord.js";
import * as kar from "../../../ai/karaoke.js";
import * as fm from "../../../lastfm/db.js";
import { execute } from "../../../commands/utility/karaoke.js";

const k = kar as unknown as Record<string, ReturnType<typeof vi.fn>>;
const f = fm as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("karaoke command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    k.isIrene.mockReturnValue(true); // default: allowed
  });

  it("hard-gates to Irene only — refuses on non-Irene clients", async () => {
    k.isIrene.mockReturnValue(false);
    const interaction: any = makeInteraction({ subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/karaoke is Irene's thing/i);
    expect(k.getStatus).not.toHaveBeenCalled();
  });

  it("refuses in DMs even for Irene", async () => {
    const interaction: any = makeInteraction({ guild: null, subcommand: "status" });
    await execute(interaction);
    expect(getLastReplyContent(interaction)).toMatch(/karaoke only works in servers/i);
  });

  describe("start", () => {
    it("defers, starts karaoke and posts a success embed", async () => {
      k.startKaraoke.mockResolvedValue({
        ok: true, trackName: "Bad Apple", artistName: "Touhou", lineCount: 42,
      });
      const interaction: any = makeInteraction({
        subcommand: "start",
        options: { song: "Bad Apple", artist: "Touhou" },
      });
      await execute(interaction);
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(k.startKaraoke).toHaveBeenCalledWith(
        interaction.client, interaction.guild.id,
        expect.objectContaining({ trackName: "Bad Apple", artistName: "Touhou", requesterId: interaction.user.id }),
      );
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/Karaoke started/);
      expect(data.description).toMatch(/42 synced lyric lines/);
    });

    it("surfaces a start failure reason", async () => {
      k.startKaraoke.mockResolvedValue({ ok: false, reason: "no lyrics found" });
      const interaction: any = makeInteraction({
        subcommand: "start",
        options: { song: "X", artist: "Y" },
      });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/couldn't start karaoke: no lyrics found/);
    });
  });

  describe("auto", () => {
    it("falls back to the linked Last.fm user when none is passed", async () => {
      f.getFmUser.mockResolvedValue({ lastfm_username: "scrobbler99" });
      k.startAutoMode.mockResolvedValue({ ok: true });
      const interaction: any = makeInteraction({ subcommand: "auto", options: {} });
      await execute(interaction);
      expect(f.getFmUser).toHaveBeenCalledWith(interaction.user.id);
      expect(k.startAutoMode).toHaveBeenCalledWith(
        interaction.client, interaction.guild.id, "scrobbler99", interaction.user.id,
      );
      expect(getLastReplyContent(interaction)).toMatch(/scrobbler99/);
    });

    it("prompts to link Last.fm when no user passed and none linked", async () => {
      f.getFmUser.mockResolvedValue(null);
      const interaction: any = makeInteraction({ subcommand: "auto", options: {} });
      await execute(interaction);
      expect(k.startAutoMode).not.toHaveBeenCalled();
      expect(getLastReplyContent(interaction)).toMatch(/link your Last\.fm with `\/fmset`/);
    });

    it("uses an explicit username without a db lookup", async () => {
      k.startAutoMode.mockResolvedValue({ ok: true });
      const interaction: any = makeInteraction({ subcommand: "auto", options: { user: "explicit_user" } });
      await execute(interaction);
      expect(f.getFmUser).not.toHaveBeenCalled();
      expect(k.startAutoMode).toHaveBeenCalledWith(
        interaction.client, interaction.guild.id, "explicit_user", interaction.user.id,
      );
    });
  });

  describe("stop / pause / resume / offset", () => {
    it("stop: returns failure reason ephemerally when nothing is running", async () => {
      k.stopKaraoke.mockResolvedValue({ ok: false, reason: "nothing playing" });
      const interaction: any = makeInteraction({ subcommand: "stop" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toBe("nothing playing");
    });

    it("stop: confirms with the track name on success", async () => {
      k.stopKaraoke.mockResolvedValue({ ok: true, trackName: "Levan Polkka" });
      const interaction: any = makeInteraction({ subcommand: "stop" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/karaoke stopped \(Levan Polkka\)/);
    });

    it("pause: shows the pause timestamp", async () => {
      k.pauseKaraoke.mockReturnValue({ ok: true, atSec: 12.34 });
      const interaction: any = makeInteraction({ subcommand: "pause" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/paused at 12\.3s/);
    });

    it("resume: shows the resume timestamp", async () => {
      k.resumeKaraoke.mockReturnValue({ ok: true, atSec: 5.0 });
      const interaction: any = makeInteraction({ subcommand: "resume" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/resumed from 5\.0s/);
    });

    it("offset: applies the shift and reports the new total offset", async () => {
      k.setOffset.mockReturnValue({ ok: true, totalOffsetSec: 1.5 });
      const interaction: any = makeInteraction({ subcommand: "offset", options: { seconds: 1.5 } });
      await execute(interaction);
      expect(k.setOffset).toHaveBeenCalledWith(interaction.guild.id, 1.5);
      expect(getLastReplyContent(interaction)).toMatch(/shifted by \+1\.5s.*total offset now 1\.5s/);
    });
  });

  describe("status", () => {
    it("reports when nothing is running", async () => {
      k.getStatus.mockReturnValue(null);
      const interaction: any = makeInteraction({ subcommand: "status" });
      await execute(interaction);
      expect(getLastReplyContent(interaction)).toMatch(/no karaoke is running here/i);
    });

    it("renders a status embed with formatted time and current line", async () => {
      k.getStatus.mockReturnValue({
        paused: false, trackName: "Song", artistName: "Artist",
        elapsedSec: 65, duration: 180, offsetSec: 0, lineCount: 10,
        autoMode: true, currentLine: "la la la",
      });
      const interaction: any = makeInteraction({ subcommand: "status" });
      await execute(interaction);
      const data = getLastReply(interaction)?.payload.embeds[0].data;
      expect(data.title).toMatch(/Playing: Song/);
      expect(data.description).toMatch(/1:05 \/ 3:00/);
      expect(data.description).toMatch(/auto \(Last\.fm\)/);
      expect(data.description).toMatch(/la la la/);
    });
  });
});
