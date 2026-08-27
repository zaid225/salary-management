import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Every test hits a live remote Postgres, and the end-to-end cases make
    // ~8 sequential requests that each open their own connection - 15s was
    // enough for a single file but not under a full-suite run.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Disable cross-file parallelism: test files share one live Postgres database with global truncation in beforeEach.
    // Running files in parallel causes races (FK violations, wrong counts) as one file's truncate wipes another's fixtures.
    fileParallelism: false,
  },
});
