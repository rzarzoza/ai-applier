import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    exclude: ["node_modules/**", ...(process.env.LIVE ? [] : ["tests/live/**"])],
  },
});
