import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lookups: [] as Array<(host: string, opts: any, cb: (...args: any[]) => void) => void>,
}));

vi.mock("undici", () => ({
  Agent: class {
    dispatch = vi.fn();

    constructor(opts: any) {
      h.lookups.push(opts.connect.lookup);
    }
  },
}));

describe("safeFetch dispatcher DNS pinning", () => {
  beforeEach(() => {
    vi.resetModules();
    h.lookups.length = 0;
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports Node/Undici lookup callbacks that request all addresses", async () => {
    const { safeFetch } = await import("../src/safeFetch.js");

    await safeFetch("https://1.1.1.1/ok");
    const lookup = h.lookups[0];

    const addresses = await new Promise((resolve, reject) => {
      lookup("api.example.test", { all: true }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    expect(addresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("keeps the single-address callback shape for older callers", async () => {
    const { safeFetch } = await import("../src/safeFetch.js");

    await safeFetch("https://8.8.8.8/ok");
    const lookup = h.lookups[0];

    const result = await new Promise((resolve, reject) => {
      lookup("api.example.test", {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "8.8.8.8", family: 4 });
  });
});
