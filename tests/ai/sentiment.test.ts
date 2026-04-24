import { describe, it, expect } from "vitest";
import { quickSentiment, classifyStyle } from "../../ai/sentiment.js";

describe("quickSentiment", () => {
  describe("basic sentiment", () => {
    it("returns positive for positive words", () => {
      expect(quickSentiment("thanks thats awesome")).toBeGreaterThan(0.3);
    });

    it("returns negative for negative words", () => {
      expect(quickSentiment("this sucks its terrible")).toBeLessThan(-0.3);
    });

    it("returns near zero for neutral text", () => {
      const score = quickSentiment("the weather is cloudy today");
      expect(Math.abs(score)).toBeLessThan(0.3);
    });

    it("returns 0 for empty/null input", () => {
      expect(quickSentiment("")).toBe(0);
      expect(quickSentiment(null as any)).toBe(0);
      expect(quickSentiment(undefined as any)).toBe(0);
    });
  });

  describe("negation handling", () => {
    it("flips positive sentiment with negation", () => {
      expect(quickSentiment("not good")).toBeLessThan(0);
    });

    it("flips negative sentiment with negation", () => {
      expect(quickSentiment("not bad")).toBeGreaterThan(0);
    });
  });

  describe("intensifiers", () => {
    it("amplifies positive sentiment", () => {
      // Use longer text so normalization doesn't clamp both to 1
      const base = quickSentiment("that was good i think");
      const intensified = quickSentiment("that was really good i think");
      expect(intensified).toBeGreaterThan(base);
    });

    it("amplifies negative sentiment", () => {
      const base = quickSentiment("that was bad i think");
      const intensified = quickSentiment("that was really bad i think");
      expect(intensified).toBeLessThan(base);
    });
  });

  describe("bigram overrides", () => {
    it("'not bad' is positive (not just flipped negative)", () => {
      expect(quickSentiment("not bad")).toBeGreaterThan(0.2);
    });

    it("'kinda mid' is slightly negative", () => {
      expect(quickSentiment("kinda mid")).toBeLessThan(0);
    });

    it("'ngl good' is positive", () => {
      expect(quickSentiment("ngl good")).toBeGreaterThan(0.3);
    });

    it("'lets go' is positive", () => {
      expect(quickSentiment("lets go")).toBeGreaterThan(0.3);
    });

    it("'im dead' is positive (laughter)", () => {
      expect(quickSentiment("im dead")).toBeGreaterThan(0.2);
    });

    it("'pretty good' is positive", () => {
      expect(quickSentiment("pretty good")).toBeGreaterThan(0.2);
    });

    it("'so bad' is very negative", () => {
      expect(quickSentiment("so bad")).toBeLessThan(-0.4);
    });
  });

  describe("emoji sentiment", () => {
    it("hearts boost positive", () => {
      expect(quickSentiment("ok ❤️")).toBeGreaterThan(quickSentiment("ok"));
    });

    it("angry emoji boosts negative", () => {
      expect(quickSentiment("ok 😡")).toBeLessThan(quickSentiment("ok"));
    });

    it("skull emoji is positive (laughter in Discord)", () => {
      // Skull emoji alone with neutral text should push positive
      expect(quickSentiment("ok 💀")).toBeGreaterThan(quickSentiment("ok"));
    });

    it("fire emoji is positive", () => {
      expect(quickSentiment("that was 🔥")).toBeGreaterThan(0);
    });
  });

  describe("sarcasm detection", () => {
    it("'oh wow' nudges negative when score is neutral", () => {
      const score = quickSentiment("oh wow really");
      expect(score).toBeLessThan(0.1); // sarcasm dampens neutral/positive
    });

    it("'yeah sure' nudges negative", () => {
      const score = quickSentiment("yeah sure whatever");
      expect(score).toBeLessThan(0);
    });

    it("does not trigger on genuinely positive 'wow'", () => {
      // High positive sentiment should not be dampened
      const score = quickSentiment("wow thats incredible amazing awesome");
      expect(score).toBeGreaterThan(0.3);
    });
  });

  describe("Discord-specific words", () => {
    it("recognizes 'pog' as positive", () => {
      expect(quickSentiment("pog")).toBeGreaterThan(0);
    });

    it("recognizes 'ratio' as negative", () => {
      expect(quickSentiment("ratio")).toBeLessThan(0);
    });

    it("recognizes 'goated' as positive", () => {
      expect(quickSentiment("goated")).toBeGreaterThan(0);
    });
  });
});

describe("classifyStyle", () => {
  it("returns 'casual' for normal messages", () => {
    expect(classifyStyle(["hey whats up", "not much", "cool"])).toBe("casual");
  });

  it("returns 'technical' for code-heavy messages", () => {
    const msgs = ["```js\nconst x = 1\n```", "```py\nprint('hi')\n```", "check this function"];
    expect(classifyStyle(msgs)).toBe("technical");
  });

  it("returns 'meme-heavy' for meme-speak", () => {
    const msgs = ["lol bruh", "based ngl", "cope ratio gg lmao fr", "deadass lowkey"];
    expect(classifyStyle(msgs)).toBe("meme-heavy");
  });

  it("returns 'casual' for too few messages", () => {
    expect(classifyStyle(["hi", "hey"])).toBe("casual");
  });
});
