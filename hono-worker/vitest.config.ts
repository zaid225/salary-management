import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Disable cross-file parallelism: test files share one live Postgres database with global truncation in beforeEach.
    // Running files in parallel causes races (FK violations, wrong counts) as one file's truncate wipes another's fixtures.
    fileParallelism: false,
  },
});
