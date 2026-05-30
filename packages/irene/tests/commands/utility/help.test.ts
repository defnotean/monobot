import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeClient, repliedText, Collection } from "../../_helpers/mockDiscord.js";

import * as help from "../../../commands/utility/help.js";

function clientWithCommands(cmds: Array<{ name: string; description: string; options?: any[]; default_member_permissions?: string }>) {
  const client = makeClient();
  const col = new Collection();
  for (const c of cmds) {
    col.set(c.name, {
      data: {
        name: c.name,
        description: c.description,
        options: c.options,
        default_member_permissions: c.default_member_permissions,
      },
    });
  }
  client.commands = col;
  client._commandDirs = new Map();
  return client;
}

describe("utility/help", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the help command with an optional command option", () => {
    expect(help.data.name).toBe("help");
  });

  it("replies with a category select-menu overview when no command name is given", async () => {
    const client = clientWithCommands([
      { name: "ban", description: "ban a user" },
      { name: "play", description: "play music" },
    ]);
    client._commandDirs = new Map([["ban", "moderation"], ["play", "music"]]);
    const interaction = makeInteraction({ client });

    await help.execute(interaction);

    const payload = interaction.reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(true);
    // a select menu component is present
    expect(payload.components?.length).toBe(1);
    const menu = payload.components[0].components[0];
    expect(menu.data.custom_id).toBe("help_category_select");
    // overview embed title
    expect(repliedText(interaction)).toContain("Commands");
  });

  it("errors when a specific command name does not exist", async () => {
    const client = clientWithCommands([{ name: "ban", description: "ban a user" }]);
    const interaction = makeInteraction({ client, options: { command: "doesnotexist" } });

    await help.execute(interaction);

    expect(repliedText(interaction)).toContain("Command Not Found");
  });

  it("shows details (description + options + required-permissions) for a known command", async () => {
    const client = clientWithCommands([
      {
        name: "embed",
        description: "build an embed",
        options: [{ name: "title", description: "the title", required: true }],
        default_member_permissions: "8192",
      },
    ]);
    const interaction = makeInteraction({ client, options: { command: "embed" } });

    await help.execute(interaction);

    const text = repliedText(interaction);
    expect(text).toContain("/embed");
    expect(text).toContain("build an embed");
    expect(text).toContain("title"); // option listed
    expect(text).toContain("required"); // required marker
    expect(text).toContain("Manage Messages"); // perms field
  });

  it("adds a cooldown note for the suggest command details", async () => {
    const client = clientWithCommands([{ name: "suggest", description: "make a suggestion" }]);
    const interaction = makeInteraction({ client, options: { command: "suggest" } });

    await help.execute(interaction);
    expect(repliedText(interaction)).toContain("60 seconds per user");
  });
});
