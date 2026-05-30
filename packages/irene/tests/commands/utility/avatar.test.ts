import { describe, it, expect } from "vitest";
// @ts-expect-error JS helper, no types
import { makeInteraction, makeUser, lastReply, repliedText } from "../../_helpers/mockDiscord.js";

import * as avatarCmd from "../../../commands/utility/avatar.js";

function lastEmbed(interaction: any) {
  const p = lastReply(interaction);
  return p.embeds[0].data ?? p.embeds[0];
}

describe("utility/avatar", () => {
  it("defaults to the invoking user when no user option is supplied", async () => {
    const self = makeUser({ username: "Self" });
    const interaction = makeInteraction({ user: self, options: { user: null } });

    await avatarCmd.execute(interaction);

    expect(self.displayAvatarURL).toHaveBeenCalled();
    const embed = lastEmbed(interaction);
    expect(embed.title).toBe("Self's Avatar");
    // the resolved avatar URL becomes the embed image
    expect(embed.image?.url).toBe(self.displayAvatarURL.mock.results[0].value);
  });

  it("targets the supplied user option over the caller", async () => {
    const self = makeUser({ username: "Caller" });
    const target = makeUser({ username: "Target" });
    const interaction = makeInteraction({ user: self, options: { user: target } });

    await avatarCmd.execute(interaction);

    expect(target.displayAvatarURL).toHaveBeenCalled();
    expect(self.displayAvatarURL).not.toHaveBeenCalled();
    expect(repliedText(interaction)).toContain("Target's Avatar");
  });
});
