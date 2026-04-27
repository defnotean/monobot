import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each firewall test spins up a worker thread — keep parallelism modest so
    // the worker pool doesn't thrash on slower CI machines.
    pool: "threads",
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
