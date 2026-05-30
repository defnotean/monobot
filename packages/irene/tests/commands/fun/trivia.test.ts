// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error - JS helper, no types
import { makeInteraction, makeUser, repliedText, lastReply } from "../../_helpers/mockDiscord.js";
import * as cmd from "../../../commands/fun/trivia.js";
// @ts-expect-error - JS source, no types
import { resetCooldown } from "../../../utils/cooldown.js";

function freshUser() {
  return makeUser({ id: `trivia-${Math.random()}` });
}

// editReply must return a message-like object exposing a collector so the
// command can attach collect/end listeners without crashing.
function attachCollector(interaction: any) {
  const handlers: Record<string, Function> = {};
  const collector = {
    on: vi.fn((evt: string, fn: Function) => { handlers[evt] = fn; }),
    _handlers: handlers,
  };
  interaction.editReply.mockImplementation(async (payload: any) => {
    interaction._replies.push({ kind: "editReply", payload });
    return { id: "msg1", createMessageComponentCollector: vi.fn(() => collector) };
  });
  return collector;
}

function triviaQuestion(value: any, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => value }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fun/trivia", () => {
  it("offers easy/medium/hard difficulty choices", () => {
    const json = cmd.data.toJSON();
    const diff = json.options.find((o: any) => o.name === "difficulty");
    expect(diff.choices.map((c: any) => c.value).sort()).toEqual(["easy", "hard", "medium"]);
  });

  it("defers, fetches, and posts the question with answer buttons", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = triviaQuestion({
      results: [{
        question: "What is 2+2?",
        correct_answer: "4",
        incorrect_answers: ["3", "5", "6"],
        category: "Math",
      }],
    });
    const interaction = makeInteraction({ user });
    attachCollector(interaction);
    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("difficulty=medium"));
    const text = repliedText(interaction);
    expect(text).toContain("What is 2+2?");
    expect(text).toContain("Math");
    // Last editReply should include a button row.
    expect(lastReply(interaction).components).toHaveLength(1);
  });

  it("uses the chosen difficulty in the API request", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = triviaQuestion({
      results: [{ question: "q", correct_answer: "a", incorrect_answers: ["b", "c", "d"], category: "c" }],
    });
    const interaction = makeInteraction({ user, options: { difficulty: "hard" } });
    attachCollector(interaction);
    await cmd.execute(interaction);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("difficulty=hard"));
  });

  it("shows an API Error when the response is not ok", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = triviaQuestion({}, false);
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("API Error");
  });

  it("errors when the API returns no results", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = triviaQuestion({ results: [] });
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Could not fetch a trivia question");
  });

  it("falls back to a generic error when fetch throws", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = vi.fn(async () => { throw new Error("boom"); });
    const interaction = makeInteraction({ user });
    await cmd.execute(interaction);
    expect(repliedText(interaction)).toContain("Failed to fetch trivia");
  });

  it("is gated by a 10s cooldown", async () => {
    const user = freshUser();
    resetCooldown("trivia", user.id);
    global.fetch = triviaQuestion({
      results: [{ question: "q", correct_answer: "a", incorrect_answers: ["b", "c", "d"], category: "c" }],
    });
    const first = makeInteraction({ user });
    attachCollector(first);
    await cmd.execute(first);

    const second = makeInteraction({ user });
    await cmd.execute(second);
    expect(second.deferReply).not.toHaveBeenCalled();
    expect(lastReply(second).content).toMatch(/Wait \d+s/);
  });
});
