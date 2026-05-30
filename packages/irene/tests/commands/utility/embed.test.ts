import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
// @ts-expect-error JS helper, no types
import { makeInteraction, repliedText } from "../../_helpers/mockDiscord.js";

import * as embedCmd from "../../../commands/utility/embed.js";

// embed.execute checks `interaction.memberPermissions?.has("ManageMessages")`
// (a string flag, not the bigint API). Build a minimal matching shim.
function memberPerms(granted: string[]) {
  return {
    has: (name: string | bigint) => granted.includes(String(name))
      || (name === PermissionFlagsBits.ManageMessages && granted.includes("ManageMessages")),
  };
}

// Build a modal-submit-like interaction whose fields return our values.
function makeModal(values: Record<string, string>, extra: any = {}) {
  const interaction = makeInteraction({});
  interaction.memberPermissions = memberPerms(["ManageMessages"]);
  interaction.channel.permissionsFor = vi.fn(() => ({
    has: (flag: bigint) => flag === PermissionFlagsBits.SendMessages || flag === PermissionFlagsBits.EmbedLinks,
  }));
  interaction.fields = {
    getTextInputValue: (id: string) => values[id] ?? "",
  };
  Object.assign(interaction, extra);
  return interaction;
}

describe("utility/embed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the embed command", () => {
    expect(embedCmd.data.name).toBe("embed");
  });

  describe("execute (permission gate)", () => {
    it("refuses members without ManageMessages and never shows a modal", async () => {
      const interaction = makeInteraction({});
      interaction.memberPermissions = memberPerms([]); // no perms
      await embedCmd.execute(interaction);

      expect(interaction.showModal).not.toHaveBeenCalled();
      expect(repliedText(interaction).toLowerCase()).toContain("permission");
    });

    // KNOWN SOURCE BUG (noted, not fixed — test-only slice): embed.js line 61
    // calls `.setMaxLength(4096)` on the description TextInput, but discord.js
    // caps a TextInput maxLength at 4000, so building the modal THROWS
    // ("Invalid number value"). Because execute() has no try/catch around the
    // modal construction, a permitted member's invocation currently throws and
    // the modal is never shown. This test pins that real (buggy) behavior so a
    // future fix (changing 4096 → 4000) will flip it to a clean modal show.
    it("currently throws when building the modal for a permitted member (setMaxLength(4096) bug)", async () => {
      const interaction = makeInteraction({});
      interaction.memberPermissions = memberPerms(["ManageMessages"]);

      await expect(embedCmd.execute(interaction)).rejects.toThrow(/Invalid number value/);
      // The bug aborts before the modal is shown.
      expect(interaction.showModal).not.toHaveBeenCalled();
    });
  });

  describe("handleEmbedModal (color & field validation)", () => {
    it("rejects a malformed hex color (not 6 chars) without sending", async () => {
      const interaction = makeModal({ embed_title: "t", embed_description: "d", embed_color: "#FFF" });
      await embedCmd.handleEmbedModal(interaction);
      expect(repliedText(interaction)).toContain("Invalid Color");
      expect(interaction.channel.send).not.toHaveBeenCalled();
    });

    it("rejects an unknown color word", async () => {
      const interaction = makeModal({ embed_title: "t", embed_description: "d", embed_color: "chartreuse" });
      await embedCmd.handleEmbedModal(interaction);
      expect(repliedText(interaction)).toContain("Invalid Color");
    });

    it("rejects more than 5 fields", async () => {
      const fields = ["a|1", "b|2", "c|3", "d|4", "e|5", "f|6"].join("\n");
      const interaction = makeModal({ embed_title: "t", embed_description: "d", embed_fields: fields });
      await embedCmd.handleEmbedModal(interaction);
      expect(repliedText(interaction)).toContain("Too Many Fields");
    });

    it("rejects a field line missing the name|value separator", async () => {
      const interaction = makeModal({ embed_title: "t", embed_description: "d", embed_fields: "justname" });
      await embedCmd.handleEmbedModal(interaction);
      expect(repliedText(interaction)).toContain("Invalid Field Format");
    });

    it("on a valid named color, previews then sends to the channel after a ✅ confirmation", async () => {
      const interaction = makeModal({ embed_title: "Hi", embed_description: "Body", embed_color: "red" });
      // followUp returns a confirm message whose reaction collector resolves to ✅.
      // (Built inline; the awaitReactions resolver yields a ✅ reaction.)
      interaction.followUp = vi.fn(async () => ({
        react: vi.fn(async () => {}),
        awaitReactions: vi.fn(async () => ({ first: () => ({ emoji: { name: "✅" } }) })),
      }));

      await embedCmd.handleEmbedModal(interaction);

      // preview reply happened first
      expect(interaction.reply).toHaveBeenCalled();
      // confirmed → posted the embed to the channel
      expect(interaction.channel.send).toHaveBeenCalledTimes(1);
      const sent = interaction.channel.send.mock.calls[0][0];
      expect(sent.embeds[0].data.title).toBe("Hi");
      expect(sent.embeds[0].data.color).toBe(0xff0000); // red
    });

    it("does NOT send to the channel when the user reacts ❌", async () => {
      const interaction = makeModal({ embed_title: "Hi", embed_description: "Body" });
      interaction.followUp = vi.fn(async () => ({
        react: vi.fn(async () => {}),
        awaitReactions: vi.fn(async () => ({ first: () => ({ emoji: { name: "❌" } }) })),
      }));

      await embedCmd.handleEmbedModal(interaction);

      expect(interaction.channel.send).not.toHaveBeenCalled();
      expect(repliedText(interaction)).toContain("Cancelled");
    });
  });
});
