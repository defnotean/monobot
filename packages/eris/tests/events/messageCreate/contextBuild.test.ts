import { describe, expect, it } from "vitest";

// @ts-expect-error - importing JS module without types
import { shouldBuildTwinStateContext } from "../../../events/messageCreate/contextBuild.js";

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
