import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  orFilter: "",
  limitValue: 0,
}));

vi.mock("../../database/core.js", () => ({
  data: { reminders: [] },
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          or(filter: string) {
            state.orFilter = filter;
            return {
              limit(limit: number) {
                state.limitValue = limit;
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        }),
      }),
    }),
  }),
}));

describe("searchNotes", () => {
  beforeEach(() => {
    state.orFilter = "";
    state.limitValue = 0;
  });

  it("strips PostgREST filter metacharacters from user query text", async () => {
    const { searchNotes } = await import("../../database/userContent.js");

    await searchNotes("123456789012345678", "raid%),user_id.neq.1,(x");

    expect(state.orFilter).toBe("title.ilike.%raid user_id neq 1 x%,content.ilike.%raid user_id neq 1 x%");
    expect(state.limitValue).toBe(10);
  });
});
