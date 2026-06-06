import { describe, expect, it } from "vitest";

// @ts-expect-error - importing JS module without types
import { buildImageTurnSuffix, shouldBuildTwinStateContext } from "../../../events/messageCreate/contextBuild.js";

describe("messageCreate contextBuild runtime gates", () => {
  it("builds twin state context only for Irene-specific intent", () => {
    expect(shouldBuildTwinStateContext("is irene awake")).toBe(true);
    expect(shouldBuildTwinStateContext("how is your twin doing")).toBe(true);
    expect(shouldBuildTwinStateContext("ask ur twin about that")).toBe(true);
    expect(shouldBuildTwinStateContext("your twin sister would know")).toBe(true);
  });

  it("does not treat unrelated twin-ish words as Irene intent", () => {
    expect(shouldBuildTwinStateContext("hey whats up")).toBe(false);
    expect(shouldBuildTwinStateContext("a serene morning")).toBe(false);
    expect(shouldBuildTwinStateContext("my twin got accepted")).toBe(false);
  });
});

describe("messageCreate contextBuild image turn suffix", () => {
  it("includes multiple local image descriptions and attachment URLs", () => {
    const suffix = buildImageTurnSuffix({
      allImageAttachments: [
        { url: "https://cdn.test/one.png" },
        { url: "https://cdn.test/two.jpg" },
      ],
      imageDescriptionBlock: "[LOCAL IMAGE EVIDENCE\n1 (one.png): a cat\n2 (two.jpg): an owl\n-- end local image evidence --]",
    });

    expect(suffix).toContain("https://cdn.test/one.png, https://cdn.test/two.jpg");
    expect(suffix).toContain("for tools only");
    expect(suffix).toContain("1 (one.png): a cat");
    expect(suffix).toContain("2 (two.jpg): an owl");
  });

  it("is empty when there are no image attachments", () => {
    expect(buildImageTurnSuffix({ allImageAttachments: [] })).toBe("");
  });
});
