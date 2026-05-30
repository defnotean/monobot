import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config.js", () => ({
  default: { colors: { primary: 0x9333ea }, geminiModel: "gemini-test-model" },
}));

vi.mock("../../../database.js", () => ({
  getMood: vi.fn(),
  getRelationship: vi.fn(),
}));

vi.mock("../../../ai/gambling.js", () => ({
  MOOD_MAX_ODDS_SHIFT: 0.1,
}));

import { makeInteraction, getLastReply } from "../../_helpers/mockDiscord.js";
import * as db from "../../../database.js";
import { execute } from "../../../commands/utility/mood.js";

const m = db as unknown as {
  getMood: ReturnType<typeof vi.fn>;
  getRelationship: ReturnType<typeof vi.fn>;
};

describe("mood command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("describes a happy mood and a positive (in-your-favor) odds shift", async () => {
    m.getMood.mockReturnValue({ mood_score: 50, energy: 80 });
    m.getRelationship.mockReturnValue({ affinity_score: 40, interactions_count: 12 });

    const interaction: any = makeInteraction();
    await execute(interaction);

    const data = getLastReply(interaction)?.payload.embeds[0].data;
    // score 50 -> "genuinely happy"
    expect(data.description).toMatch(/genuinely happy/);
    expect(data.description).toMatch(/score \*\*50\*\*/);

    // pctShift = (50/100) * 0.1 * 100 = 5.00% positive
    const oddsField = data.fields.find((f: any) => f.name === "Gambling odds modifier");
    expect(oddsField.value).toMatch(/\+5\.00%/);
    expect(oddsField.value).toMatch(/in your favor/);
    // hard cap = 0.1 * 100 = 10%
    expect(oddsField.value).toMatch(/±10%/);

    // affinity 40 > 30 -> she likes you
    const affField = data.fields.find((f: any) => f.name === "How she feels about you");
    expect(affField.value).toMatch(/she likes you/);
    expect(affField.value).toMatch(/affinity \*\*40\*\*/);
    expect(affField.value).toMatch(/12 interactions/);
  });

  it("describes a bad mood, an against-you shift, and a salty affinity", async () => {
    m.getMood.mockReturnValue({ mood_score: -50, energy: 20 });
    m.getRelationship.mockReturnValue({ affinity_score: -50, interactions_count: 0 });

    const interaction: any = makeInteraction();
    await execute(interaction);

    const data = getLastReply(interaction)?.payload.embeds[0].data;
    // score -50 -> "in a bad mood"
    expect(data.description).toMatch(/in a bad mood/);
    const oddsField = data.fields.find((f: any) => f.name === "Gambling odds modifier");
    expect(oddsField.value).toMatch(/-5\.00%/);
    expect(oddsField.value).toMatch(/against you/);

    const affField = data.fields.find((f: any) => f.name === "How she feels about you");
    expect(affField.value).toMatch(/not a fan/);
  });

  it("clamps out-of-range mood/affinity scores and treats neutral as basically neutral", async () => {
    m.getMood.mockReturnValue({ mood_score: 0, energy: 999 }); // energy clamps to 100
    m.getRelationship.mockReturnValue({ affinity_score: 5, interactions_count: 3 });

    const interaction: any = makeInteraction();
    await execute(interaction);

    const data = getLastReply(interaction)?.payload.embeds[0].data;
    // score 0 -> "neutral"
    expect(data.description).toMatch(/neutral/);
    expect(data.description).toMatch(/energy \*\*100\*\*/); // clamped
    const oddsField = data.fields.find((f: any) => f.name === "Gambling odds modifier");
    expect(oddsField.value).toMatch(/\+0\.00%/);
    expect(oddsField.value).toMatch(/basically neutral/);

    // affinity 5 is between -10 and 30 -> neutral ground
    const affField = data.fields.find((f: any) => f.name === "How she feels about you");
    expect(affField.value).toMatch(/neutral ground/);
  });

  it("uses the interacting user's relationship", async () => {
    m.getMood.mockReturnValue({ mood_score: 0, energy: 50 });
    m.getRelationship.mockReturnValue({ affinity_score: 0, interactions_count: 0 });
    const interaction: any = makeInteraction();
    await execute(interaction);
    expect(m.getRelationship).toHaveBeenCalledWith(interaction.user.id);
  });
});
