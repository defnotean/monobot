import { describe, expect, it } from "vitest";

describe("WP6 shared dedup exports", () => {
  it("exposes the extracted tier-1 shared modules through package exports", async () => {
    const [
      bumpReminder,
      bumpCelebrations,
      bumpAnalytics,
      bumpCorrelation,
      opinions,
      aiBudget,
      preoccupations,
      openaiCompat,
      humanity,
      longmemory,
    ] = await Promise.all([
      import("@defnotean/shared/bumpReminder"),
      import("@defnotean/shared/bumpCelebrations"),
      import("@defnotean/shared/bumpAnalytics"),
      import("@defnotean/shared/bumpCorrelation"),
      import("@defnotean/shared/opinions"),
      import("@defnotean/shared/aiBudget"),
      import("@defnotean/shared/preoccupations"),
      import("@defnotean/shared/openaiCompat"),
      import("@defnotean/shared/humanity"),
      import("@defnotean/shared/longmemory"),
    ]);

    expect(bumpReminder.createBumpReminder).toBeTypeOf("function");
    expect(bumpCelebrations.createBumpCelebrations).toBeTypeOf("function");
    expect(bumpAnalytics.createBumpAnalytics).toBeTypeOf("function");
    expect(bumpCorrelation.createBumpCorrelation).toBeTypeOf("function");
    expect(opinions.createOpinions).toBeTypeOf("function");
    expect(aiBudget.checkBudget).toBeTypeOf("function");
    expect(preoccupations.createPreoccupations).toBeTypeOf("function");
    expect(openaiCompat.createOpenAICompatProvider).toBeTypeOf("function");
    expect(humanity.createHumanity).toBeTypeOf("function");
    expect(longmemory.createLongMemory).toBeTypeOf("function");
  });
});
