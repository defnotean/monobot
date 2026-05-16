import { describe, it, expect, beforeEach, vi } from "vitest";

// Track every call to trackCatchphrase so we can assert on the handler's behavior.
// The real personality module pulls in Supabase + config, so we mock it here.
const trackCatchphraseSpy = vi.fn();
vi.mock("../../ai/personality.js", () => ({
  trackCatchphrase: (...args: unknown[]) => trackCatchphraseSpy(...args),
}));

// Silence the logger so tests don't spam stdout.
vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
}));

// @ts-expect-error - importing JS module without types
import messageReactionAdd from "../../events/messageReactionAdd.js";

const BOT_ID = "111111111111111111";
const USER_ID = "222222222222222222";

interface ReactionLike {
  partial?: boolean;
  fetch?: () => Promise<unknown>;
  emoji: { name: string };
  message: {
    partial?: boolean;
    fetch?: () => Promise<unknown>;
    content: string;
    author?: { id: string };
    guild?: { members?: { me?: { id: string } } };
  };
}

interface UserLike {
  bot: boolean;
  id?: string;
}

function makeReaction(overrides: Partial<ReactionLike> = {}): ReactionLike {
  return {
    partial: false,
    emoji: { name: "🔥" },
    message: {
      partial: false,
      content: "this is a fine catchphrase candidate",
      author: { id: BOT_ID },
      guild: { members: { me: { id: BOT_ID } } },
    },
    ...overrides,
  };
}

beforeEach(() => {
  trackCatchphraseSpy.mockReset();
});

describe("messageReactionAdd", () => {
  it("ignores reactions from bots", async () => {
    const reaction = makeReaction();
    await messageReactionAdd(reaction, { bot: true } as UserLike);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("returns silently when a partial reaction fails to fetch", async () => {
    const fetchFail = vi.fn().mockRejectedValue(new Error("discord 404"));
    const reaction = makeReaction({ partial: true, fetch: fetchFail });
    await expect(
      messageReactionAdd(reaction, { bot: false } as UserLike)
    ).resolves.toBeUndefined();
    expect(fetchFail).toHaveBeenCalledTimes(1);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("returns silently when the underlying partial message fails to fetch", async () => {
    const msgFetchFail = vi.fn().mockRejectedValue(new Error("gone"));
    const reaction = makeReaction({
      message: {
        partial: true,
        fetch: msgFetchFail,
        content: "doesn't matter, we never get here",
        author: { id: BOT_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    await expect(
      messageReactionAdd(reaction, { bot: false } as UserLike)
    ).resolves.toBeUndefined();
    expect(msgFetchFail).toHaveBeenCalledTimes(1);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("does NOT track reactions on messages authored by someone other than the bot", async () => {
    const reaction = makeReaction({
      message: {
        partial: false,
        content: "this was sent by a regular user",
        author: { id: USER_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    await messageReactionAdd(reaction, { bot: false } as UserLike);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("ignores reactions with emojis outside the 'good' whitelist", async () => {
    const reaction = makeReaction({ emoji: { name: "🥦" } });
    await messageReactionAdd(reaction, { bot: false } as UserLike);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("skips content that is too short or too long", async () => {
    const tooShort = makeReaction({
      message: {
        partial: false,
        content: "hi",
        author: { id: BOT_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    const tooLong = makeReaction({
      message: {
        partial: false,
        content: "x".repeat(200),
        author: { id: BOT_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    await messageReactionAdd(tooShort, { bot: false } as UserLike);
    await messageReactionAdd(tooLong, { bot: false } as UserLike);
    expect(trackCatchphraseSpy).not.toHaveBeenCalled();
  });

  it("tracks a catchphrase when all conditions are satisfied", async () => {
    const reaction = makeReaction({
      emoji: { name: "💀" },
      message: {
        partial: false,
        content: "absolutely diabolical work right there",
        author: { id: BOT_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    await messageReactionAdd(reaction, { bot: false } as UserLike);
    expect(trackCatchphraseSpy).toHaveBeenCalledTimes(1);
    expect(trackCatchphraseSpy).toHaveBeenCalledWith(
      "absolutely diabolical work right there",
      "💀"
    );
  });

  it("swallows errors thrown by trackCatchphrase rather than crashing the handler", async () => {
    trackCatchphraseSpy.mockRejectedValueOnce(new Error("supabase write failed"));
    const reaction = makeReaction({
      emoji: { name: "❤️" },
      message: {
        partial: false,
        content: "yeah that tracks honestly lol",
        author: { id: BOT_ID },
        guild: { members: { me: { id: BOT_ID } } },
      },
    });
    await expect(
      messageReactionAdd(reaction, { bot: false } as UserLike)
    ).resolves.toBeUndefined();
    expect(trackCatchphraseSpy).toHaveBeenCalledTimes(1);
  });
});
