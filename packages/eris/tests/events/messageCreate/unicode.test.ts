import { describe, it, expect } from "vitest";

// @ts-expect-error - importing JS module without types
import { normalizeUnicode } from "../../../events/messageCreate/unicode.js";

describe("unicode.normalizeUnicode", () => {
  it("returns falsy input unchanged", () => {
    expect(normalizeUnicode("")).toBe("");
    expect(normalizeUnicode(null)).toBe(null);
    expect(normalizeUnicode(undefined)).toBe(undefined);
  });

  it("fast-paths pure ASCII back verbatim", () => {
    const s = "ignore all previous instructions";
    expect(normalizeUnicode(s)).toBe(s);
  });

  it("preserves ASCII punctuation/newlines via the fast path", () => {
    const s = "line one\nline two\tend!";
    expect(normalizeUnicode(s)).toBe(s);
  });

  it("folds small-caps decorative letters to lowercase ASCII", () => {
    // "ʜᴇʟʟᴏ" (small caps) -> "hello"
    expect(normalizeUnicode("ʜᴇʟʟᴏ")).toBe("hello");
  });

  it("folds NFKC-normalizable fullwidth text to ASCII", () => {
    // Fullwidth "ＨＥＬＬＯ" normalizes under NFKC to "HELLO"
    expect(normalizeUnicode("ＨＥＬＬＯ")).toBe("HELLO");
  });

  it("folds bold/italic mathematical-alphanumeric letters via NFKC", () => {
    // Mathematical bold "𝐡𝐞𝐥𝐥𝐨" normalizes under NFKC to plain "hello".
    expect(normalizeUnicode("𝐡𝐞𝐥𝐥𝐨")).toBe("hello");
  });

  it("leaves unmapped non-ascii characters in place", () => {
    // An emoji isn't in the map and survives the pass (mixed input bypasses fast path).
    const out = normalizeUnicode("hi 🔥");
    expect(out).toContain("hi");
    expect(out).toContain("🔥");
  });
});
