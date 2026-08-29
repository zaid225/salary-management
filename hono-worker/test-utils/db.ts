import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import type { Db } from "../src/models/db.js";
import type { CloudflareBindings } from "../src/lib/context.js";

// Every test file truncates eight tables in beforeEach. If TEST_DATABASE_URL
// and DATABASE_URL are the same database, running the suite destroys real
// data - this has actually happened, so it is a hard failure rather than a
// warning. Set ALLOW_DESTRUCTIVE_TESTS_ON_PROD_DB=1 only if you genuinely
// mean it.
function assertNotProductionDatabase(url: string): void {
  const prod = process.env.DATABASE_URL;
  if (!prod || process.env.ALLOW_DESTRUCTIVE_TESTS_ON_PROD_DB === "1") return;

  const identity = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return u;
    }
  };

  if (identity(url) === identity(prod)) {
    throw new Error(
      "Refusing to run tests: TEST_DATABASE_URL points at the same database as DATABASE_URL, " +
        "and the suite TRUNCATEs every table before each test file. " +
        "Point TEST_DATABASE_URL at a separate database.",
    );
  }
}

export function testDb(): { db: Db; client: ReturnType<typeof postgres> } {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL not set - see .env.test.example");
  assertNotProductionDatabase(url);
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
    FRONTEND_URL: "",
    PII_ENCRYPTION_KEY: "",
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
    sql`TRUNCATE TABLE payroll_run_lines, payroll_runs, ai_proposals, pii_tokens, ledger_balances, ledger_events, job_logs, jobs, audit_log, salary_records, employees, fx_rates, invitations, memberships, organizations, users RESTART IDENTITY CASCADE`,
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
