import type { Config } from "drizzle-kit";

// drizzle-kit runs locally/in CI, never inside the Worker - it talks to
// DATABASE_URL directly, bypassing Hyperdrive entirely (migrations are a
// deploy-time concern, not a per-request one).
export default {
  schema: "./src/models/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: (globalThis as typeof globalThis & {
      process?: { env?: { DATABASE_URL?: string } };
    }).process?.env?.DATABASE_URL ?? "",
  },
} satisfies Config;
