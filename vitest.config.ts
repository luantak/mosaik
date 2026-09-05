import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Match node:test's unlimited default. Individual tests can still set a timeout.
    testTimeout: 0,
  },
});
