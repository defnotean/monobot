import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeGuild, makeUser, makeMember, makeClient, repliedText, PermissionFlagsBits } from "../../_helpers/mockDiscord.js";

import * as tag from "../../../commands/utility/tag.js";

let gseq = 0;
function ctx(sub: string, opts: Record<string, any> = {}, perms: any[] = [PermissionFlagsBits.ManageMessages]) {
  const guild = makeGuild({ id: `tag-guild-${gseq++}` });
  const user = makeUser();
  const member = makeMember({ user, guild, permissions: perms });
  const client = makeClient();
  const interaction = makeInteraction({ guild, user, member, client, subcommand: sub, options: opts });
  return interaction;
}

describe("utility/tag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    tag.initTagData({ tags: {} });
  });

  it("declares the tag command", () => {
    expect(tag.data.name).toBe("tag");
  });

  describe("create (permission + validation)", () => {
    it("refuses members without ManageMessages", async () => {
      const interaction = ctx("create", { name: "hello", content: "world content" }, []);
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Permission Denied");
      expect(tag.getTagData()[interaction.guild.id]).toBeUndefined();
    });

    it("rejects an invalid tag name (uppercase / spaces)", async () => {
      const interaction = ctx("create", { name: "Bad Name!", content: "some content" });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Invalid Tag Name");
    });

    it("creates a valid tag and stores it", async () => {
      const interaction = ctx("create", { name: "welcome", content: "Welcome to the server!" });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Tag Created");
      const store = tag.getTagData()[interaction.guild.id];
      expect(store.welcome.content).toBe("Welcome to the server!");
    });

    it("refuses creating a duplicate tag name", async () => {
      const gid = "dup-guild";
      tag.initTagData({ tags: { [gid]: { existing: { content: "x", createdBy: "u", createdAt: Date.now() } } } });
      const guild = makeGuild({ id: gid });
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.ManageMessages] });
      const interaction = makeInteraction({ guild, user, member, subcommand: "create", options: { name: "existing", content: "new content here" } });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Tag Exists");
    });
  });

  describe("get (no perms required)", () => {
    it("retrieves an existing tag publicly", async () => {
      const gid = "get-guild";
      tag.initTagData({ tags: { [gid]: { rules: { content: "Be nice.", createdBy: "u", createdAt: Date.now() } } } });
      const guild = makeGuild({ id: gid });
      const interaction = makeInteraction({ guild, subcommand: "get", options: { name: "RULES" } }); // case-insensitive
      await tag.execute(interaction);
      const text = repliedText(interaction);
      expect(text).toContain("Be nice.");
      // public reply (no ephemeral flag on the get reply)
      const payload = interaction.reply.mock.calls[0][0];
      expect(payload.flags).toBeUndefined();
    });

    it("reports Tag Not Found for an unknown name", async () => {
      const interaction = ctx("get", { name: "missing" });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Tag Not Found");
    });
  });

  describe("edit & delete", () => {
    it("edits an existing tag's content", async () => {
      const gid = "edit-guild";
      tag.initTagData({ tags: { [gid]: { faq: { content: "old", createdBy: "u", createdAt: Date.now() } } } });
      const guild = makeGuild({ id: gid });
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.ManageMessages] });
      const interaction = makeInteraction({ guild, user, member, subcommand: "edit", options: { name: "faq", content: "brand new content" } });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Tag Updated");
      expect(tag.getTagData()[gid].faq.content).toBe("brand new content");
    });

    it("delete reports not found when the tag is absent", async () => {
      const interaction = ctx("delete", { name: "ghost" });
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("Tag Not Found");
    });
  });

  describe("list & info", () => {
    it("list says 'No Tags' for an empty guild", async () => {
      const interaction = ctx("list");
      await tag.execute(interaction);
      expect(repliedText(interaction)).toContain("No Tags");
    });

    it("list renders the tag names via the paginator", async () => {
      const gid = "list-guild";
      tag.initTagData({ tags: { [gid]: { alpha: { content: "a", createdBy: "u", createdAt: 1 }, beta: { content: "b", createdBy: "u", createdAt: 1 } } } });
      const guild = makeGuild({ id: gid });
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.ManageMessages] });
      const interaction = makeInteraction({ guild, user, member, subcommand: "list", options: {} });
      await tag.execute(interaction);
      // paginate calls interaction.reply with the first page embed
      const text = repliedText(interaction);
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("info shows creator and content length, resolving the creator via client.users.fetch", async () => {
      const gid = "info-guild";
      tag.initTagData({ tags: { [gid]: { howto: { content: "12345", createdBy: "creator-id", createdAt: Date.now() } } } });
      const guild = makeGuild({ id: gid });
      const user = makeUser();
      const member = makeMember({ user, guild, permissions: [PermissionFlagsBits.ManageMessages] });
      const client = makeClient();
      client.users.fetch = vi.fn(async () => makeUser({ id: "creator-id", username: "TheCreator" }));
      const interaction = makeInteraction({ guild, user, member, client, subcommand: "info", options: { name: "howto" } });
      await tag.execute(interaction);

      expect(client.users.fetch).toHaveBeenCalledWith("creator-id");
      const text = repliedText(interaction);
      expect(text).toContain("TheCreator");
      expect(text).toContain("5 chars");
    });
  });
});
