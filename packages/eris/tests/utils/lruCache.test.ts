import { describe, it, expect, beforeEach } from "vitest";
import { LRUCache } from "@defnotean/shared/LRUCache";

describe("LRUCache", () => {
  let cache: InstanceType<typeof LRUCache>;

  beforeEach(() => {
    cache = new LRUCache(3);
  });

  it("stores and retrieves values", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("returns undefined for missing keys", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts oldest entry when at capacity", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // should evict "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("get() refreshes entry position (LRU)", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // "a" is now most recently used
    cache.set("d", 4); // should evict "b" (oldest), not "a"
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("set() updates existing entry value", () => {
    cache.set("a", 1);
    cache.set("a", 99);
    expect(cache.get("a")).toBe(99);
    expect(cache.size).toBe(1);
  });

  it("delete() removes entry", () => {
    cache.set("a", 1);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear() removes all entries", () => {
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("has() returns correct boolean", () => {
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  describe("TTL", () => {
    it("expires entries after TTL", async () => {
      const ttlCache = new LRUCache(10, 50); // 50ms TTL
      ttlCache.set("a", 1);
      expect(ttlCache.get("a")).toBe(1);
      await new Promise(r => setTimeout(r, 60));
      expect(ttlCache.get("a")).toBeUndefined();
    });

    it("has() returns false for expired entries", async () => {
      const ttlCache = new LRUCache(10, 50);
      ttlCache.set("a", 1);
      await new Promise(r => setTimeout(r, 60));
      expect(ttlCache.has("a")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("works with maxSize = 1", () => {
      const tiny = new LRUCache(1);
      tiny.set("a", 1);
      tiny.set("b", 2);
      expect(tiny.get("a")).toBeUndefined();
      expect(tiny.get("b")).toBe(2);
      expect(tiny.size).toBe(1);
    });

    it("handles null and undefined values", () => {
      cache.set("null", null);
      cache.set("undef", undefined);
      expect(cache.get("null")).toBeNull();
      expect(cache.get("undef")).toBeUndefined(); // same as missing — by design
    });

    it("keys() returns all keys", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.keys()).toEqual(["a", "b"]);
    });
  });
});
