import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import type { Db } from "../src/models/db.js";
import type { CloudflareBindings } from "../src/lib/context.js";

export function testDb(): { db: Db; client: ReturnType<typeof postgres> } {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set - see .env.test.example");
  const client = postgres(url, { max: 5 });
  return { db: drizzle(client, { schema }), client };
}

// Fabricates the same env shape getDb(env) expects, so route tests can call
// app.fetch(req, testEnv()) without an actual Cloudflare Worker runtime -
// getDb() only ever reads env.HYPERDRIVE.connectionString.
export function testEnv(overrides: Record<string, string> = {}): CloudflareBindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set - see .env.test.example");
  return {
    NODE_ENV: "test",
    DATABASE_URL: url,
    MONGODB_DATA_API_URL: "",
    MONGODB_DATA_API_KEY: "",
    MONGODB_DATA_SOURCE: "",
    CLERK_SECRET_KEY: "test-secret",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_WEBHOOK_SECRET: "",
    OPENROUTER_API_KEY: "",
    UNSPLASH_ACCESS_KEY: "",
    PARALLEL_API_KEY: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    QSTASH_TOKEN: "",
    ALLOWED_ORIGIN: "",
    POSTMARK_SERVER_TOKEN: "",
    POSTMARK_FROM_EMAIL: "",
    SEED_ADMIN_CLERK_USER_ID: "",
    HYPERDRIVE: { connectionString: url } as Hyperdrive,
    ...overrides,
  };
}

export async function truncateAll(db: Db): Promise<void> {
  // fx_rates is listed explicitly: nothing references it, so CASCADE from
  // the org-scoped tables would never reach it and its seeded rows would
  // survive into the next test file as duplicate-PK conflicts.
  await db.execute(
    sql`TRUNCATE TABLE audit_log, salary_records, employees, fx_rates, invitations, memberships, organizations, users RESTART IDENTITY CASCADE`,
  );
}

// Hono's Context.executionCtx throws "This context has no ExecutionContext"
// if app.fetch() is called without one - every handler that does
// c.executionCtx.waitUntil(conn.close()) needs this passed as the third
// argument to app.fetch(request, env, executionCtx) in every test.
export function testExecutionCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}
