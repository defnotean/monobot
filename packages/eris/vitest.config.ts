import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // A handful of tests load very heavy module graphs lazily inside the
    // function under test (discord.js, GoogleGenAI, the ready.js fan-out,
    // the bumpCelebrations -> bumpAnalytics chain). When vitest runs test
    // files in parallel workers those `await import(...)` calls contend
    // for CPU/transform work and can blow past the default 5000ms per-test
    // budget on a cold worker — even though each test only does microseconds
    // of real assertion work. Bumping the global ceiling stabilizes them
    // without slowing the suite: fast tests still finish in single-digit ms.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
