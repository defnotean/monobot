import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeInteraction, getLastReply } from "../../_helpers/mockDiscord.js";
import { execute, STEPS, buildStep } from "../../../commands/utility/tutorial.js";

describe("tutorial command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replies ephemerally with the first step", async () => {
    const interaction: any = makeInteraction();
    await execute(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = getLastReply(interaction)?.payload;
    // MessageFlags.Ephemeral
    expect(payload.flags).toBeTruthy();
    expect(payload.embeds[0].data.title).toBe(STEPS[0].title);
    expect(payload.components).toHaveLength(1);
  });

  it("buildStep: first step has Next + Skip but no Back", () => {
    const { components } = buildStep(STEPS[0], 0) as any;
    const ids = components[0].components.map((c: any) => c.data.custom_id);
    expect(ids).toContain("tutorial_0_next");
    expect(ids).toContain("tutorial_0_skip");
    expect(ids.some((id: string) => id.endsWith("_back"))).toBe(false);
  });

  it("buildStep: middle step has Back + Next", () => {
    const { components } = buildStep(STEPS[2], 2) as any;
    const ids = components[0].components.map((c: any) => c.data.custom_id);
    expect(ids).toContain("tutorial_2_back");
    expect(ids).toContain("tutorial_2_next");
    expect(ids.some((id: string) => id.endsWith("_done"))).toBe(false);
  });

  it("buildStep: last step uses Done instead of Next", () => {
    const lastIdx = STEPS.length - 1;
    const { components } = buildStep(STEPS[lastIdx], lastIdx) as any;
    const ids = components[0].components.map((c: any) => c.data.custom_id);
    expect(ids).toContain(`tutorial_${lastIdx}_done`);
    expect(ids).toContain(`tutorial_${lastIdx}_back`);
    expect(ids.some((id: string) => id.endsWith("_next"))).toBe(false);
  });

  it("buildStep: footer reflects the step position", () => {
    const { embeds } = buildStep(STEPS[1], 1) as any;
    expect(embeds[0].data.footer.text).toBe(`Step 2 of ${STEPS.length}`);
  });
});
