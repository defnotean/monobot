import { describe, expect, it } from "vitest";

describe("humanity shared export", () => {
  it("exposes the shared humanity factory through an extensionless subpath", async () => {
    const humanity = await import("@defnotean/shared/humanity");

    expect(humanity.createHumanity).toBeTypeOf("function");
  });
});
