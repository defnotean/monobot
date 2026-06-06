// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../config.js", () => ({
  default: { ownerId: "OWNER_ID", twinBotId: "ERIS_ID" },
}));
vi.mock("../../../utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../../database.js", () => ({
  shiftMood: vi.fn(),
  isFeatureEnabled: vi.fn(() => true),
}));
// dreams.js is dynamically imported by triggerSleep — stub it.
vi.mock("../../../ai/dreams.js", () => ({
  generateDream: vi.fn(async () => {}),
}));

import {
  getMentionRegex,
  trackMessage,
  addWarning,
  markBotResponded,
  triggerSleep,
  isSleeping,
  wakeSleep,
  detectAddressing,
  detectChannelAiSilenceCommand,
  shouldSkipTwinMessage,
  SLEEP_TRIGGERS,
  NAP_TRIGGERS,
  _userHistory,
  _twinExchanges,
} from "../../../events/messageCreate/gates.js";
import { isFeatureEnabled } from "../../../database.js";
// @ts-expect-error JS helper, no types
import { makeMessage, makeUser, makeMember, makeGuild, makeChannel, makeClient, Collection } from "../../_helpers/mockDiscord.js";

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabled.mockReturnValue(true);
});

describe("gates / getMentionRegex", () => {
  it("builds a regex that matches both <@id> and <@!id>", () => {
    const re = getMentionRegex("123");
    expect("<@123>".match(re)).toBeTruthy();
    expect("<@!123>".match(getMentionRegex("123"))).toBeTruthy();
  });
});

describe("gates / SLEEP_TRIGGERS & NAP_TRIGGERS", () => {
  it("SLEEP matches goodnight phrases, not casual chat", () => {
    expect(SLEEP_TRIGGERS.test("good night everyone")).toBe(true);
    expect(SLEEP_TRIGGERS.test("im going to sleep")).toBe(true);
    expect(SLEEP_TRIGGERS.test("how are you")).toBe(false);
  });

  it("NAP matches nap phrases, not casual chat", () => {
    expect(NAP_TRIGGERS.test("gonna take a nap")).toBe(true);
    expect(NAP_TRIGGERS.test("power nap time")).toBe(true);
    expect(NAP_TRIGGERS.test("let's play a game")).toBe(false);
  });
});

describe("gates / trackMessage + addWarning + markBotResponded", () => {
  // Use unique guild/user ids per test so the module-level _userHistory cache
  // never leaks state between tests.
  it("counts an identical message as a repeat once the bot has responded", () => {
    const g = "rep_g_" + Math.random().toString(36).slice(2);
    const u = "rep_u";
    // First message: count 1 (no prior entry).
    expect(trackMessage(g, u, "hello").count).toBe(1);
    // Mark that the bot replied, so the next identical message is a true repeat.
    markBotResponded(g, u);
    expect(trackMessage(g, u, "hello").count).toBe(2);
  });

  it("resets the repeat count when the message text changes", () => {
    const g = "diff_g_" + Math.random().toString(36).slice(2);
    const u = "diff_u";
    trackMessage(g, u, "hello");
    markBotResponded(g, u);
    expect(trackMessage(g, u, "hello").count).toBe(2);
    markBotResponded(g, u);
    expect(trackMessage(g, u, "something else").count).toBe(1);
  });

  it("treats a re-send as a retry (count 1) when the bot did NOT respond", () => {
    const g = "retry_g_" + Math.random().toString(36).slice(2);
    const u = "retry_u";
    expect(trackMessage(g, u, "hi").count).toBe(1);
    // No markBotResponded → same message again is a legit retry, stays at 1.
    expect(trackMessage(g, u, "hi").count).toBe(1);
  });

  it("addWarning increments and returns the running total", () => {
    const g = "warn_g_" + Math.random().toString(36).slice(2);
    const u = "warn_u";
    trackMessage(g, u, "x");
    expect(addWarning(g, u)).toBe(1);
    expect(addWarning(g, u)).toBe(2);
  });

  it("addWarning returns 0 for an unknown user", () => {
    expect(addWarning("never_seen_g_" + Math.random(), "seen")).toBe(0);
  });
});

describe("gates / sleep state", () => {
  it("triggerSleep(nap) makes isSleeping true; wakeSleep clears it", () => {
    expect(isSleeping()).toBe(false);
    triggerSleep(true);
    expect(isSleeping()).toBe(true);
    wakeSleep();
    expect(isSleeping()).toBe(false);
  });

  it("triggerSleep(full sleep) sets sleeping until cleared", () => {
    triggerSleep(false);
    expect(isSleeping()).toBe(true);
    wakeSleep();
    expect(isSleeping()).toBe(false);
  });
});

describe("gates / detectAddressing", () => {
  const getServerPersona = () => ({ name: "" });

  function msg(content, { withEris = false } = {}) {
    const botUser = makeUser({ id: "BOT", username: "irene" });
    const client = makeClient({ user: botUser });
    const guild = makeGuild({ id: "g1" });
    guild.members.cache = new Collection();
    if (withEris) {
      const eris = makeMember({ user: makeUser({ id: "ERIS_ID", username: "eris" }) });
      eris.displayName = "eris";
      guild.members.cache.set("ERIS_ID", eris);
    }
    const m = makeMessage({ content, client, guild, mentionsUsers: content.includes("<@BOT>") ? [botUser] : [] });
    return m;
  }

  it("flags an explicit @mention of the bot", () => {
    const r = detectAddressing(msg("<@BOT> hey"), getServerPersona);
    expect(r.mentioned).toBe(true);
  });

  it("flags saidMyName when the username appears", () => {
    const r = detectAddressing(msg("hey irene how are you"), getServerPersona);
    expect(r.saidMyName).toBe(true);
  });

  it("does not flag saidMyName for unrelated text", () => {
    const r = detectAddressing(msg("just talking about lunch"), getServerPersona);
    expect(r.saidMyName).toBe(false);
    expect(r.mentioned).toBe(false);
  });

  it("flags mentionsEris when Eris's name is used", () => {
    const r = detectAddressing(msg("hey eris what's up", { withEris: true }), getServerPersona);
    expect(r.mentionsEris).toBe(true);
  });

  it("flags mentionsEris when the twin bot id appears in content", () => {
    const r = detectAddressing(msg("ping ERIS_ID now"), getServerPersona);
    expect(r.mentionsEris).toBe(true);
  });
});

describe("gates / detectChannelAiSilenceCommand", () => {
  const getServerPersona = () => ({ name: "" });

  function msg(content, { addressed = true } = {}) {
    const botUser = makeUser({ id: "BOT", username: "irene" });
    const client = makeClient({ user: botUser });
    const guild = makeGuild({ id: "g1" });
    return makeMessage({
      content,
      client,
      guild,
      mentionsUsers: addressed && content.includes("<@BOT>") ? [botUser] : [],
    });
  }

  it("detects an addressed request to stop messaging in this chat", () => {
    expect(detectChannelAiSilenceCommand(msg("Irene stop messaging in this chat okay?"), getServerPersona))
      .toBe("silence");
  });

  it("detects an addressed request not to type here", () => {
    expect(detectChannelAiSilenceCommand(msg("<@BOT> don't type here"), getServerPersona))
      .toBe("silence");
  });

  it("ignores unaddressed chatter that says not to type here", () => {
    expect(detectChannelAiSilenceCommand(msg("GIRL DON'T TYPE HERE", { addressed: false }), getServerPersona))
      .toBeNull();
  });

  it("detects an addressed request to resume talking here", () => {
    expect(detectChannelAiSilenceCommand(msg("Irene you can talk here again"), getServerPersona))
      .toBe("unsilence");
  });

  it("does not persist ambiguous one-off stop wording without a channel scope", () => {
    expect(detectChannelAiSilenceCommand(msg("Irene stop talking"), getServerPersona))
      .toBeNull();
  });
});

describe("gates / shouldSkipTwinMessage", () => {
  function twinMsg({ content = "hey", embeds = [], components = [], channelId = "ch-skip" } = {}) {
    const botUser = makeUser({ id: "BOT", username: "irene" });
    const client = makeClient({ user: botUser });
    const guild = makeGuild({ id: "g1" });
    const channel = makeChannel({ id: channelId, guild });
    const m = makeMessage({ content, client, guild, channel });
    m.embeds = embeds;
    m.components = components;
    return m;
  }

  it("skips an embed-only admin/log message (no text)", async () => {
    const m = twinMsg({ content: "", embeds: [{ title: "Config" }] });
    expect(await shouldSkipTwinMessage(m)).toBe(true);
  });

  it("skips a log-style message containing 'banned'", async () => {
    const m = twinMsg({ content: "user was banned for spam" });
    expect(await shouldSkipTwinMessage(m)).toBe(true);
  });

  it("skips a game embed (e.g. blackjack)", async () => {
    const m = twinMsg({ content: "", embeds: [{ title: "Blackjack table" }] });
    expect(await shouldSkipTwinMessage(m)).toBe(true);
  });

  it("skips when twin_chat feature is disabled for the guild", async () => {
    isFeatureEnabled.mockReturnValue(false);
    const m = twinMsg({ content: "hi irene", channelId: "ch-disabled" });
    expect(await shouldSkipTwinMessage(m)).toBe(true);
  });

  it("skips a near-duplicate of the last twin message (loop prevention)", async () => {
    isFeatureEnabled.mockReturnValue(true);
    const channelId = "ch-dup-" + Math.random().toString(36).slice(2);
    // Seed the per-channel last-content directly so the duplicate-similarity
    // branch is exercised deterministically (no dependence on the random
    // chime-in path of a prior call).
    _twinExchanges.set(channelId, {
      count: 1,
      lastTwinMsg: Date.now(),
      lastContent: "lets talk about the weather today",
    });
    const dup = twinMsg({ content: "lets talk about the weather today", channelId });
    // >0.6 word-overlap with lastContent → loop prevention → skip.
    expect(await shouldSkipTwinMessage(dup)).toBe(true);
  });

  it("does NOT skip on the similarity branch for unrelated content (random forced to respond)", async () => {
    isFeatureEnabled.mockReturnValue(true);
    const channelId = "ch-fresh-" + Math.random().toString(36).slice(2);
    _twinExchanges.set(channelId, {
      count: 0,
      lastTwinMsg: Date.now(),
      lastContent: "completely different earlier topic",
    });
    // Force the random gates to the "respond" side so only deterministic
    // branches decide the outcome.
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const msg = twinMsg({ content: "hey irene whats up", channelId });
      // directedAtMe (says "irene"), count becomes 1, random 0.99 ≥ 0.70 → respond.
      expect(await shouldSkipTwinMessage(msg)).toBe(false);
    } finally {
      rnd.mockRestore();
    }
  });
});
