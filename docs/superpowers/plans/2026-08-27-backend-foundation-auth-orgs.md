# Backend Foundation: Schema, Auth Middleware & Organizations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the salary-management app's identity/tenancy foundation in `hono-worker`: the users/organizations/memberships/invitations schema, the `resolveOrg`/`requireRole` auth middleware, the Clerk-webhook identity sync, and a full organizations/invitations/members API — all independently testable via `vitest` and `curl`, with no frontend required yet.

**Architecture:** Clerk verifies *who* the caller is (`requireAuth`, already built); everything about *which organization* and *what role* is our own DB-backed `resolveOrg` middleware reading an `X-Org-Id` header (or `:orgId` path param) against a `memberships` row. Every organization-scoped query goes through a small `scopedDb(db, orgId)` helper so the isolation filter can't be forgotten. Identity (name/email/avatar) is mirrored locally via a signature-verified Clerk webhook so it never needs a live Clerk API call per request.

**Tech Stack:** Hono on Cloudflare Workers, Drizzle ORM (`postgres-js` driver) over Supabase Postgres via Hyperdrive, `zod/v4`, `@hono/zod-validator`, `svix` (webhook signature verification), `@upstash/ratelimit`, Postmark HTTP API (no SDK — plain `fetch`), Vitest against a real disposable Postgres.

**Spec:** `docs/superpowers/specs/2026-08-26-salary-management-design.md` (sections referenced below by §).

## Global Constraints

- Import zod as `zod/v4`, never bare `zod` (validation.md rule 2 — the codebase has already hit this bug once).
- Every error response is `{ error: { message, statusCode } }` (`onError`/`notFound` in `error.middleware.ts` — already correct, don't bypass it with a hand-rolled shape).
- Every list endpoint is paginated: default `limit=25`, max `100`, clamp don't reject (spec §4).
- Every domain table's leading compound-index column is `organization_id` (spec §3) — never a table that mixes tenants without it.
- Soft-delete only, never a hard `DELETE` row (spec §5 — `memberships.status = 'removed'`, not a deleted row).
- Every new external call (`fetch` to Postmark, DB queries) is timeout-bounded or already pooled per Hyperdrive's existing pattern — no unbounded waits (scaling-resilience.md rule 1).
- Every optional integration (Postmark, Upstash, Clerk webhook secret) degrades to a no-op/clear-error when its env var is unset — never crashes route registration or boot (env-vars.md rule 4).
- Log via `logger` from `src/lib/logger.ts`, never a bare `console.log` in route/controller code (error-handling-logging.md rule 2).
- `getDb(c.env)` returns `{ db, close } | null` — every handler that touches the DB checks for `null` (503) and calls `c.executionCtx.waitUntil(conn.close())` in a `finally` block, matching `sessions.controller.ts`'s existing pattern exactly.

---

## File Structure

```
hono-worker/
  src/
    models/
      schema.ts            # REWRITE: users, organizations, memberships, invitations (drops old sessions/chunks)
      scoped-db.ts          # NEW: org-scoped query helpers
      scoped-db.test.ts     # NEW
    lib/
      context.ts            # MODIFY: Variables gains orgId/orgRole
      env.ts                # MODIFY: + CLERK_WEBHOOK_SECRET, POSTMARK_SERVER_TOKEN, POSTMARK_FROM_EMAIL, SEED_ADMIN_CLERK_USER_ID
      slug.ts                # NEW: slugify()
      postmark.ts            # NEW: sendInviteEmail()
      postmark.test.ts       # NEW
    controllers/
      auth.middleware.ts     # MODIFY: + resolveOrg, requireRole
      auth.middleware.test.ts # NEW
      rate-limit.middleware.ts # MODIFY: + rateLimitByOrg
      webhooks.controller.ts  # NEW: Clerk user.created/updated -> users upsert
      organizations.controller.ts # NEW
      invitations.controller.ts   # NEW
      members.controller.ts       # NEW
    schemas/
      organization.schema.ts # NEW
      invitation.schema.ts   # NEW
      membership.schema.ts   # NEW
    routes/
      webhooks.routes.ts       # NEW
      webhooks.routes.test.ts  # NEW
      organizations.routes.ts  # NEW
      organizations.routes.test.ts # NEW
      invitations.routes.ts    # NEW
      invitations.routes.test.ts # NEW
      members.routes.ts        # NEW
      members.routes.test.ts   # NEW
      sessions.routes.ts       # DELETE (old hackathon scaffold)
    controllers/sessions.controller.ts # DELETE
    index.ts                 # MODIFY: register new routes, drop sessions route
    index.test.ts             # NEW: cross-tenant isolation end-to-end test
  test-utils/
    db.ts                     # NEW: testDb(), testEnv(), truncateAll()
  vitest.config.ts             # NEW
  vitest.setup.ts               # NEW
  .env.test.example              # NEW
  package.json                   # MODIFY: + vitest, dotenv, svix; + test script
fastify-api/                     # DELETE (whole directory, unused scaffold)
```

---

### Task 1: Remove obsolete hackathon scaffolding

**Files:**
- Delete: `fastify-api/` (entire directory)
- Delete: `hono-worker/src/routes/sessions.routes.ts`
- Delete: `hono-worker/src/controllers/sessions.controller.ts`
- Modify: `hono-worker/src/index.ts:1-39`

**Interfaces:** none (pure removal) — produces a clean `index.ts` for later tasks to add routes to.

- [ ] **Step 1: Delete the unused scaffolding**

```bash
git rm -r fastify-api
git rm hono-worker/src/routes/sessions.routes.ts hono-worker/src/controllers/sessions.controller.ts
```

- [ ] **Step 2: Remove the sessions route wiring from `index.ts`**

Remove the `import { sessionsRoutes } from "./routes/sessions.routes.js";` line and the `app.route("/api", sessionsRoutes);` line. Resulting `hono-worker/src/index.ts`:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings } from "./lib/context.js";
import { onError, notFound } from "./controllers/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { exampleRoutes } from "./routes/example.routes.js";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  c.set("reqId", crypto.randomUUID());
  await next();
});

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN;
      if (c.env.NODE_ENV !== "production") return origin ?? "*";
      return allowed && origin === allowed ? origin : "";
    },
  }),
);

app.onError(onError);
app.notFound(notFound);

app.get("/", (c) => c.json({ name: "swades-hackathon-worker", status: "ok" }));

app.route("/api", healthRoutes);
app.route("/api", exampleRoutes);

export default app;
```

- [ ] **Step 3: Verify the worker still typechecks**

Run: `cd hono-worker && npm run typecheck`
Expected: no errors (the old `sessions`/`chunks` exports in `schema.ts` are now unused but that's not a type error — Task 2 replaces the file entirely).

- [ ] **Step 4: Commit**

```bash
git add hono-worker/src/index.ts
git commit -m "chore: remove unused fastify-api scaffold and hackathon sessions/chunks routes"
```

---

### Task 2: Identity/org schema, migration, and test infrastructure

**Files:**
- Modify: `hono-worker/src/models/schema.ts` (full rewrite)
- Create: `hono-worker/test-utils/db.ts`
- Create: `hono-worker/vitest.config.ts`
- Create: `hono-worker/vitest.setup.ts`
- Create: `hono-worker/.env.test.example`
- Modify: `hono-worker/package.json`
- Create: `hono-worker/src/models/schema.test.ts`

**Interfaces:**
- Produces: `users`, `organizations`, `memberships`, `invitations` (Drizzle table objects, `hono-worker/src/models/schema.ts`) — every later task's schema imports come from here.
- Produces: `testDb(): { db: Db; client: Sql }`, `testEnv(overrides?: Record<string, string>): CloudflareBindings`, `testExecutionCtx(): ExecutionContext`, `truncateAll(db: Db): Promise<void>` (`hono-worker/test-utils/db.ts`) — every later `*.test.ts` in this plan imports from here. Any route test calling `app.fetch(request, env)` must pass `testExecutionCtx()` as a third argument, or Hono throws `"This context has no ExecutionContext"` the moment a handler calls `c.executionCtx.waitUntil(...)`.

- [ ] **Step 1: Add test/runtime dependencies**

```bash
cd hono-worker
npm install svix
npm install -D vitest dotenv
```

- [ ] **Step 2: Add test scripts to `package.json`**

Add under `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Write the schema (overwrites the old sessions/chunks schema)**

`hono-worker/src/models/schema.ts`:

```ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
  uniqueIndex,
  index,
  sql,
} from "drizzle-orm/pg-core";

// --- Local mirror of Clerk identity, kept in sync via webhook (design spec §3) ---
// Clerk stays the source of truth for auth; this table exists so member
// lists/audit-log entries can show a name/email/avatar without an
// out-of-band Clerk API call on every request.

export const users = pgTable("users", {
  clerkUserId: varchar("clerk_user_id", { length: 255 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 200 }),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Organizations, membership, invitations (custom, not Clerk Orgs — design spec §5) ---

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_organizations_slug").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // admin | viewer
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | removed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_memberships_org_user").on(t.organizationId, t.clerkUserId),
    index("idx_memberships_user").on(t.clerkUserId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // admin | viewer
    token: varchar("token", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | accepted | revoked
    invitedBy: varchar("invited_by", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_invitations_token").on(t.token),
    // Idempotency: one live invite per (org, email) at a time
    // (idempotency-checksums.md rule 3's upsert-over-insert principle).
    uniqueIndex("uq_invitations_org_email_pending")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);
```

- [ ] **Step 4: Write the test harness**

`hono-worker/test-utils/db.ts`:

```ts
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
  await db.execute(
    sql`TRUNCATE TABLE invitations, memberships, organizations, users RESTART IDENTITY CASCADE`,
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
```

`hono-worker/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
```

`hono-worker/vitest.setup.ts`:

```ts
import { config } from "dotenv";
import { vi } from "vitest";

config({ path: ".env.test" });

// Route tests authenticate with `Authorization: Bearer <clerkUserId>` -
// verifyToken just echoes the token back as `sub`, so tests never need a
// real Clerk session. Pass token "invalid" to exercise the 401 path.
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "invalid") throw new Error("invalid token");
    return { sub: token };
  }),
}));
```

`hono-worker/.env.test.example`:

```
# Copy to .env.test (gitignored) and point at a disposable local Postgres.
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/salary_mgmt_test
```

- [ ] **Step 5: Write the failing smoke test**

`hono-worker/src/models/schema.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "./schema.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

describe("schema", () => {
  it("persists an organization and its membership", async () => {
    const [org] = await db.insert(organizations).values({ name: "ACME Corp", slug: "acme" }).returning();

    await db.insert(memberships).values({
      organizationId: org.id,
      clerkUserId: "user_1",
      role: "admin",
      status: "active",
    });

    const rows = await db.select().from(memberships).where(eq(memberships.organizationId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("admin");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Ensure a local Postgres is running and `TEST_DATABASE_URL` is set (copy `.env.test.example` to `.env.test`, adjust if needed), then:

Run: `cd hono-worker && npm test`
Expected: FAIL — `relation "organizations" does not exist` (schema not yet pushed to the test database).

- [ ] **Step 7: Generate and apply the migration**

```bash
cd hono-worker
DATABASE_URL=$TEST_DATABASE_URL npm run db:generate
```

Review the generated SQL under `hono-worker/drizzle/` — it should be four `CREATE TABLE` statements plus the unique/index constraints above, nothing destructive (per this repo's `db-migrations` skill). Then apply it:

```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:push
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd hono-worker && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add hono-worker/src/models/schema.ts hono-worker/src/models/schema.test.ts \
  hono-worker/test-utils hono-worker/vitest.config.ts hono-worker/vitest.setup.ts \
  hono-worker/.env.test.example hono-worker/package.json hono-worker/package-lock.json \
  hono-worker/drizzle
git commit -m "feat: identity/org schema (users, organizations, memberships, invitations) + test harness"
```

---

### Task 3: Env vars and request-context types

**Files:**
- Modify: `hono-worker/src/lib/env.ts`
- Modify: `hono-worker/src/lib/context.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Env` gains `CLERK_WEBHOOK_SECRET`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL`, `SEED_ADMIN_CLERK_USER_ID` (all `z.string().default("")`). `Variables` gains `orgId?: string` and `orgRole?: "admin" | "viewer"` — every later task's middleware/controller reads these via `c.get("orgId")`/`c.get("orgRole")`.

- [ ] **Step 1: Extend the env schema**

`hono-worker/src/lib/env.ts` — add four lines inside `EnvSchema`:

```ts
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().default(""),
  MONGODB_DATA_API_URL: z.string().default(""),
  MONGODB_DATA_API_KEY: z.string().default(""),
  MONGODB_DATA_SOURCE: z.string().default(""),
  CLERK_SECRET_KEY: z.string().default(""),
  CLERK_PUBLISHABLE_KEY: z.string().default(""),
  CLERK_WEBHOOK_SECRET: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),
  UNSPLASH_ACCESS_KEY: z.string().default(""),
  PARALLEL_API_KEY: z.string().default(""),
  UPSTASH_REDIS_REST_URL: z.string().default(""),
  UPSTASH_REDIS_REST_TOKEN: z.string().default(""),
  QSTASH_TOKEN: z.string().default(""),
  ALLOWED_ORIGIN: z.string().default(""),
  POSTMARK_SERVER_TOKEN: z.string().default(""),
  POSTMARK_FROM_EMAIL: z.string().default(""),
  SEED_ADMIN_CLERK_USER_ID: z.string().default(""),
});
```

- [ ] **Step 2: Extend request-context `Variables`**

`hono-worker/src/lib/context.ts`:

```ts
import type { Env } from "./env.js";

export type CloudflareBindings = Env & {
  HYPERDRIVE?: Hyperdrive;
};

export type Variables = {
  reqId: string;
  userId?: string;
  orgId?: string;
  orgRole?: "admin" | "viewer";
};
export type AppBindings = { Bindings: CloudflareBindings; Variables: Variables };
```

- [ ] **Step 3: Typecheck**

Run: `cd hono-worker && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add hono-worker/src/lib/env.ts hono-worker/src/lib/context.ts
git commit -m "feat: add org/webhook/postmark env vars and orgId/orgRole request context"
```

---

### Task 4: `scopedDb` — organization-scoped query helper

**Files:**
- Create: `hono-worker/src/models/scoped-db.ts`
- Create: `hono-worker/src/models/scoped-db.test.ts`

**Interfaces:**
- Consumes: `Db` (`hono-worker/src/models/db.ts`), `memberships`/`invitations` (`hono-worker/src/models/schema.ts`).
- Produces: `scopedDb(db: Db, organizationId: string): { memberships: { listActive(): Promise<Membership[]>; countActiveAdmins(): Promise<number> }; invitations: { listPending(): Promise<Invitation[]>; findPendingByEmail(email: string): Promise<Invitation | null> } }` — Task 9 (invitations) and Task 10 (members) call these directly.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/models/scoped-db.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, invitations } from "./schema.js";
import { scopedDb } from "./scoped-db.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

async function seedTwoOrgs() {
  const [orgA] = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const [orgB] = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();

  await db.insert(memberships).values([
    { organizationId: orgA.id, clerkUserId: "user_a1", role: "admin", status: "active" },
    { organizationId: orgA.id, clerkUserId: "user_a2", role: "viewer", status: "active" },
    { organizationId: orgB.id, clerkUserId: "user_b1", role: "admin", status: "active" },
  ]);

  await db.insert(invitations).values([
    {
      organizationId: orgA.id,
      email: "pending@a.com",
      role: "viewer",
      token: "token-a-1",
      status: "pending",
      invitedBy: "user_a1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      organizationId: orgB.id,
      email: "pending@b.com",
      role: "viewer",
      token: "token-b-1",
      status: "pending",
      invitedBy: "user_b1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ]);

  return { orgA, orgB };
}

describe("scopedDb", () => {
  it("never returns another organization's memberships or invitations", async () => {
    const { orgA, orgB } = await seedTwoOrgs();

    const scopedA = scopedDb(db, orgA.id);
    const membersA = await scopedA.memberships.listActive();
    expect(membersA).toHaveLength(2);
    expect(membersA.every((m) => m.organizationId === orgA.id)).toBe(true);

    const invitesA = await scopedA.invitations.listPending();
    expect(invitesA).toHaveLength(1);
    expect(invitesA[0].organizationId).toBe(orgA.id);

    const scopedB = scopedDb(db, orgB.id);
    expect(await scopedB.memberships.listActive()).toHaveLength(1);
  });

  it("counts only active admins within the given organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    expect(await scopedA.memberships.countActiveAdmins()).toBe(1);
  });

  it("finds a pending invitation by email, scoped to the organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    const found = await scopedA.invitations.findPendingByEmail("pending@a.com");
    expect(found?.email).toBe("pending@a.com");
    expect(await scopedA.invitations.findPendingByEmail("pending@b.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- scoped-db`
Expected: FAIL with "Cannot find module './scoped-db.js'".

- [ ] **Step 3: Implement `scopedDb`**

`hono-worker/src/models/scoped-db.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { memberships, invitations } from "./schema.js";
import type { Db } from "./db.js";

// Every organization-scoped query goes through here so the org_id filter
// can never be forgotten in a route handler (design spec §5).
export function scopedDb(db: Db, organizationId: string) {
  return {
    memberships: {
      listActive: () =>
        db
          .select()
          .from(memberships)
          .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, "active"))),

      countActiveAdmins: async (): Promise<number> => {
        const rows = await db
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.status, "active"),
              eq(memberships.role, "admin"),
            ),
          );
        return rows.length;
      },
    },
    invitations: {
      listPending: () =>
        db
          .select()
          .from(invitations)
          .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, "pending"))),

      findPendingByEmail: async (email: string) => {
        const [row] = await db
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.organizationId, organizationId),
              eq(invitations.email, email),
              eq(invitations.status, "pending"),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hono-worker && npm test -- scoped-db`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add hono-worker/src/models/scoped-db.ts hono-worker/src/models/scoped-db.test.ts
git commit -m "feat: add scopedDb org-isolation query helper"
```

---

### Task 5: `resolveOrg` and `requireRole` middleware

**Files:**
- Modify: `hono-worker/src/controllers/auth.middleware.ts`
- Create: `hono-worker/src/controllers/auth.middleware.test.ts`

**Interfaces:**
- Consumes: `getDb` (`../models/db.js`), `memberships` (`../models/schema.js`), `AppBindings` (`../lib/context.js`).
- Produces: `resolveOrg(c, next): Promise<Response | void>` — sets `c.set("orgId", ...)` and `c.set("orgRole", "admin" | "viewer")`. `requireRole(role: "admin"): (c, next) => Promise<Response | void>`. Every route task from here on (7, 8, 9, 10) composes `requireAuth, resolveOrg[, requireRole("admin")]`.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/controllers/auth.middleware.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { resolveOrg, requireRole } from "./auth.middleware.js";
import type { AppBindings } from "../lib/context.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

// Isolates resolveOrg/requireRole from requireAuth's Clerk call - a
// preceding test-only middleware sets userId directly from a header.
function buildTestApp() {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-test-user") ?? "");
    await next();
  });
  app.get("/test", resolveOrg, requireRole("admin"), (c) =>
    c.json({ ok: true, orgId: c.get("orgId"), orgRole: c.get("orgRole") }),
  );
  return app;
}

async function seedOrgWithMembers() {
  const [org] = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  await db.insert(memberships).values([
    { organizationId: org.id, clerkUserId: "user_admin", role: "admin", status: "active" },
    { organizationId: org.id, clerkUserId: "user_viewer", role: "viewer", status: "active" },
    { organizationId: org.id, clerkUserId: "user_removed", role: "admin", status: "removed" },
  ]);
  return org;
}

describe("resolveOrg + requireRole", () => {
  it("400s when X-Org-Id is missing", async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", { headers: { "x-test-user": "user_admin" } }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("403s for a user with no active membership in that org", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_stranger", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("403s for a removed membership", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_removed", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("403s an active viewer against requireRole(admin)", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_viewer", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("200s an active admin and sets orgId/orgRole", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_admin", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, orgId: org.id, orgRole: "admin" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- auth.middleware`
Expected: FAIL — `resolveOrg`/`requireRole` not exported yet.

- [ ] **Step 3: Implement the middleware**

Append to `hono-worker/src/controllers/auth.middleware.ts` (keep the existing `requireAuth` untouched):

```ts
import { and, eq } from "drizzle-orm";
import { getDb } from "../models/db.js";
import { memberships } from "../models/schema.js";

// Resolves *which organization* a request acts on, and the caller's role
// in it. Accepts either an X-Org-Id header or a :orgId path param (routes
// like /organizations/:orgId/members carry both, in which case they must
// agree). Org access is authorized here, and only here, against a
// DB-verified active membership row - never trusted from client input
// directly (design spec §5).
export async function resolveOrg(c: Context<AppBindings>, next: Next): Promise<Response | void> {
  const headerOrgId = c.req.header("X-Org-Id");
  const paramOrgId = c.req.param("orgId");
  if (paramOrgId && headerOrgId && paramOrgId !== headerOrgId) {
    return c.json(
      { error: { message: "X-Org-Id header does not match :orgId path param", statusCode: 400 } },
      400,
    );
  }
  const orgId = headerOrgId ?? paramOrgId;
  if (!orgId) {
    return c.json({ error: { message: "X-Org-Id header required", statusCode: 400 } }, 400);
  }

  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  try {
    const [membership] = await conn.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, orgId),
          eq(memberships.clerkUserId, c.get("userId") ?? ""),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: { message: "Not a member of this organization", statusCode: 403 } }, 403);
    }

    c.set("orgId", orgId);
    c.set("orgRole", membership.role as "admin" | "viewer");
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }

  await next();
}

export function requireRole(role: "admin") {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | void> => {
    if (c.get("orgRole") !== role) {
      return c.json({ error: { message: "Forbidden", statusCode: 403 } }, 403);
    }
    await next();
  };
}
```

(`Context`, `Next`, and `AppBindings` are already imported at the top of this file for `requireAuth` — no new import lines needed for those three.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hono-worker && npm test -- auth.middleware`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add hono-worker/src/controllers/auth.middleware.ts hono-worker/src/controllers/auth.middleware.test.ts
git commit -m "feat: add resolveOrg and requireRole middleware"
```

---

### Task 6: Postmark invite-email helper

**Files:**
- Create: `hono-worker/src/lib/postmark.ts`
- Create: `hono-worker/src/lib/postmark.test.ts`

**Interfaces:**
- Consumes: `CloudflareBindings` (`./context.js`), `logger` (`./logger.js`).
- Produces: `sendInviteEmail(env: CloudflareBindings, params: { to: string; orgName: string; inviterName: string; acceptUrl: string }): Promise<boolean>` — Task 9's invitation controller calls this.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/lib/postmark.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendInviteEmail } from "./postmark.js";
import { testEnv } from "../../test-utils/db.js";

describe("sendInviteEmail", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns false without calling Postmark when POSTMARK_SERVER_TOKEN is unset", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to Postmark's API and returns true on 200", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "tok_123" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.postmarkapp.com/email",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns false (never throws) when the fetch itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "tok_123" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- postmark`
Expected: FAIL — `./postmark.js` doesn't exist.

- [ ] **Step 3: Implement `sendInviteEmail`**

`hono-worker/src/lib/postmark.ts`:

```ts
import type { CloudflareBindings } from "./context.js";
import { logger } from "./logger.js";

interface SendInviteEmailParams {
  to: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
}

// Fire-and-forget relative to the caller: never throws. The invitation row
// is already the source of truth by the time this is called (design spec
// §5) - a Postmark outage or an unset token degrades to "share the link
// manually" rather than failing invite creation (scaling-resilience.md
// rule 1's timeout, error-handling-logging.md rule 6's "log it, don't
// swallow silently").
export async function sendInviteEmail(
  env: CloudflareBindings,
  params: SendInviteEmailParams,
): Promise<boolean> {
  if (!env.POSTMARK_SERVER_TOKEN) return false;

  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: env.POSTMARK_FROM_EMAIL || "no-reply@example.com",
        To: params.to,
        Subject: `${params.inviterName} invited you to join ${params.orgName}`,
        TextBody: `${params.inviterName} invited you to join ${params.orgName} on the Salary Management app.\n\nAccept: ${params.acceptUrl}\n\nThis link expires in 7 days.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, "postmark send failed (non-2xx)");
    }
    return res.ok;
  } catch (err) {
    logger.error({ err: String(err) }, "postmark send failed");
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hono-worker && npm test -- postmark`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add hono-worker/src/lib/postmark.ts hono-worker/src/lib/postmark.test.ts
git commit -m "feat: add Postmark invite-email helper (fire-and-forget)"
```

---

### Task 7: Clerk webhook — identity sync into `users`

**Files:**
- Create: `hono-worker/src/controllers/webhooks.controller.ts`
- Create: `hono-worker/src/routes/webhooks.routes.ts`
- Create: `hono-worker/src/routes/webhooks.routes.test.ts`

**Interfaces:**
- Consumes: `getDb`, `users` table, `svix`'s `Webhook`.
- Produces: `webhooksRoutes: Hono<AppBindings>` mounted at `/api/webhooks/clerk` — Task 11 registers it in `index.ts`.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/routes/webhooks.routes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { users } from "../models/schema.js";
import { webhooksRoutes } from "./webhooks.routes.js";
import { eq } from "drizzle-orm";

const { db, client } = testDb();
// The bytes svix's Webhook.verify() actually HMACs with are whatever is
// base64-decoded out of the "whsec_" secret - encoding SECRET_RAW's own
// bytes here means signedRequest() below reproduces exactly what
// verify() expects, without depending on svix's own signing helper.
const SECRET_RAW = "test-secret-for-webhook-signing-1234567890";
const SECRET = `whsec_${Buffer.from(SECRET_RAW).toString("base64")}`;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function signedRequest(body: unknown): Request {
  const payload = JSON.stringify(body);
  const id = "msg_test_1";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedContent = `${id}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", Buffer.from(SECRET_RAW)).update(signedContent).digest("base64");

  return new Request("http://test/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
}

describe("POST /webhooks/clerk", () => {
  it("401s on a bad signature", async () => {
    const req = new Request("http://test/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": "x", "svix-timestamp": "1", "svix-signature": "bad" },
      body: "{}",
    });
    const res = await webhooksRoutes.fetch(req, testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res.status).toBe(401);
  });

  it("upserts a users row on user.created", async () => {
    const req = signedRequest({
      type: "user.created",
      data: {
        id: "user_new",
        email_addresses: [{ email_address: "new@example.com" }],
        first_name: "New",
        last_name: "User",
        image_url: "https://img.example.com/a.png",
      },
    });
    const res = await webhooksRoutes.fetch(req, testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res.status).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.clerkUserId, "user_new"));
    expect(row.email).toBe("new@example.com");
    expect(row.name).toBe("New User");
  });

  it("is idempotent on a repeated user.updated event", async () => {
    const makeReq = () =>
      signedRequest({
        type: "user.updated",
        data: {
          id: "user_dup",
          email_addresses: [{ email_address: "dup@example.com" }],
          first_name: "Dup",
          last_name: null,
          image_url: null,
        },
      });

    await webhooksRoutes.fetch(makeReq(), testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    const res2 = await webhooksRoutes.fetch(makeReq(), testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res2.status).toBe(200);

    const rows = await db.select().from(users).where(eq(users.clerkUserId, "user_dup"));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- webhooks.routes`
Expected: FAIL — `./webhooks.routes.js` doesn't exist.

- [ ] **Step 3: Implement the controller**

`hono-worker/src/controllers/webhooks.controller.ts`:

```ts
import type { Context } from "hono";
import { Webhook } from "svix";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { users } from "../models/schema.js";
import { logger } from "../lib/logger.js";

interface ClerkWebhookEvent {
  type: string;
  data: {
    id: string;
    email_addresses?: { email_address: string }[];
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
  };
}

export async function handleClerkWebhook(c: Context<AppBindings>): Promise<Response> {
  if (!c.env.CLERK_WEBHOOK_SECRET) {
    return c.json({ error: { message: "Webhook not configured", statusCode: 501 } }, 501);
  }

  const payload = await c.req.text();
  const headers = {
    "svix-id": c.req.header("svix-id") ?? "",
    "svix-timestamp": c.req.header("svix-timestamp") ?? "",
    "svix-signature": c.req.header("svix-signature") ?? "",
  };

  let event: ClerkWebhookEvent;
  try {
    const wh = new Webhook(c.env.CLERK_WEBHOOK_SECRET);
    event = wh.verify(payload, headers) as ClerkWebhookEvent;
  } catch {
    // Never log the payload/secret - api-security.md rule 3.
    return c.json({ error: { message: "Invalid webhook signature", statusCode: 401 } }, 401);
  }

  if (event.type !== "user.created" && event.type !== "user.updated") {
    return c.json({ status: "ignored" });
  }

  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  try {
    const email = event.data.email_addresses?.[0]?.email_address ?? "";
    const name = [event.data.first_name, event.data.last_name].filter(Boolean).join(" ") || null;

    await conn.db
      .insert(users)
      .values({
        clerkUserId: event.data.id,
        email,
        name,
        avatarUrl: event.data.image_url ?? null,
      })
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: { email, name, avatarUrl: event.data.image_url ?? null, updatedAt: new Date() },
      });

    logger.info({ clerkUserId: event.data.id, type: event.type }, "synced user from Clerk webhook");
    return c.json({ status: "ok" });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
```

- [ ] **Step 4: Implement the route**

`hono-worker/src/routes/webhooks.routes.ts`:

```ts
import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { handleClerkWebhook } from "../controllers/webhooks.controller.js";

export const webhooksRoutes = new Hono<AppBindings>();

webhooksRoutes.post("/webhooks/clerk", handleClerkWebhook);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hono-worker && npm test -- webhooks.routes`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add hono-worker/src/controllers/webhooks.controller.ts hono-worker/src/routes/webhooks.routes.ts \
  hono-worker/src/routes/webhooks.routes.test.ts
git commit -m "feat: Clerk webhook syncs user.created/updated into local users table"
```

---

### Task 8: Organizations API

**Files:**
- Create: `hono-worker/src/lib/slug.ts`
- Create: `hono-worker/src/schemas/organization.schema.ts`
- Create: `hono-worker/src/controllers/organizations.controller.ts`
- Create: `hono-worker/src/routes/organizations.routes.ts`
- Create: `hono-worker/src/routes/organizations.routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task in place), `getDb`, `organizations`/`memberships`.
- Produces: `organizationsRoutes: Hono<AppBindings>` (mounted at `/api`, exposing `POST /organizations`, `GET /organizations`) — Task 11 registers it.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/routes/organizations.routes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { memberships } from "../models/schema.js";
import { organizationsRoutes } from "./organizations.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string) {
  return { Authorization: `Bearer ${userId}` };
}

describe("POST /organizations", () => {
  it("creates an org and makes the creator its admin", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "ACME Corp" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.organization.name).toBe("ACME Corp");

    const rows = await db.select().from(memberships).where(eq(memberships.organizationId, body.organization.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clerkUserId: "user_1", role: "admin", status: "active" });
  });

  it("401s without a bearer token", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ACME Corp" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("400s on an empty name", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /organizations", () => {
  it("lists only the organizations the caller belongs to", async () => {
    await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "Org One" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_2"), "content-type": "application/json" },
        body: JSON.stringify({ name: "Org Two" }),
      }),
      testEnv(), testExecutionCtx(),
    );

    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", { headers: authed("user_1") }),
      testEnv(), testExecutionCtx(),
    );
    const body = await res.json();
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0].organization.name).toBe("Org One");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- organizations.routes`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `slugify`**

`hono-worker/src/lib/slug.ts`:

```ts
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
```

- [ ] **Step 4: Implement the schema**

`hono-worker/src/schemas/organization.schema.ts`:

```ts
import { z } from "zod/v4";

export const CreateOrganizationBody = z.object({
  name: z.string().min(1).max(200),
});
```

- [ ] **Step 5: Implement the controller**

`hono-worker/src/controllers/organizations.controller.ts`:

```ts
import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, memberships } from "../models/schema.js";
import { slugify } from "../lib/slug.js";
import type { CreateOrganizationBody } from "../schemas/organization.schema.js";

type CreateOrgIn = { in: { json: z.input<typeof CreateOrganizationBody> }; out: { json: z.infer<typeof CreateOrganizationBody> } };

export async function createOrganization(c: Context<AppBindings, string, CreateOrgIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const { name } = c.req.valid("json");
  const userId = c.get("userId")!;

  try {
    const base = slugify(name) || "org";
    let slug = base;
    let org: typeof organizations.$inferSelect | undefined;

    for (let attempt = 0; attempt < 5 && !org; attempt++) {
      try {
        [org] = await conn.db.insert(organizations).values({ name, slug }).returning();
      } catch {
        slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    if (!org) {
      return c.json(
        { error: { message: "Could not allocate a unique organization slug, try a different name", statusCode: 500 } },
        500,
      );
    }

    await conn.db.insert(memberships).values({
      organizationId: org.id,
      clerkUserId: userId,
      role: "admin",
      status: "active",
    });

    return c.json({ organization: org }, 201);
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function listMyOrganizations(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const userId = c.get("userId")!;
  try {
    const rows = await conn.db
      .select({ organization: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(and(eq(memberships.clerkUserId, userId), eq(memberships.status, "active")));

    return c.json({ organizations: rows });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
```

- [ ] **Step 6: Implement the route**

`hono-worker/src/routes/organizations.routes.ts`:

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth } from "../controllers/auth.middleware.js";
import { CreateOrganizationBody } from "../schemas/organization.schema.js";
import { createOrganization, listMyOrganizations } from "../controllers/organizations.controller.js";

export const organizationsRoutes = new Hono<AppBindings>();

const validateCreateOrg = zValidator("json", CreateOrganizationBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

organizationsRoutes.post("/organizations", requireAuth, validateCreateOrg, createOrganization);
organizationsRoutes.get("/organizations", requireAuth, listMyOrganizations);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd hono-worker && npm test -- organizations.routes`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add hono-worker/src/lib/slug.ts hono-worker/src/schemas/organization.schema.ts \
  hono-worker/src/controllers/organizations.controller.ts hono-worker/src/routes/organizations.routes.ts \
  hono-worker/src/routes/organizations.routes.test.ts
git commit -m "feat: POST/GET /organizations"
```

---

### Task 9: Invitations API (create + accept)

**Files:**
- Create: `hono-worker/src/schemas/invitation.schema.ts`
- Create: `hono-worker/src/controllers/invitations.controller.ts`
- Create: `hono-worker/src/routes/invitations.routes.ts`
- Create: `hono-worker/src/routes/invitations.routes.test.ts`
- Modify: `hono-worker/src/controllers/rate-limit.middleware.ts` (append `rateLimitByOrg`)

**Interfaces:**
- Consumes: `requireAuth`, `resolveOrg`, `requireRole("admin")` (Task 5), `scopedDb` (Task 4), `sendInviteEmail` (Task 6), `organizations`/`users`/`memberships`/`invitations`.
- Produces: `invitationsRoutes: Hono<AppBindings>` exposing `POST /organizations/:orgId/invitations`, `POST /invitations/:token/accept` — Task 11 registers it.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/routes/invitations.routes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, invitations } from "../models/schema.js";
import { invitationsRoutes } from "./invitations.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
  vi.restoreAllMocks();
  global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${userId}`, "content-type": "application/json" };
  if (orgId) headers["X-Org-Id"] = orgId;
  return headers;
}

async function seedAdminOrg() {
  const [org] = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  await db.insert(memberships).values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

describe("POST /organizations/:orgId/invitations", () => {
  it("creates a pending invitation and emails it", async () => {
    const org = await seedAdminOrg();
    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "new@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitation.email).toBe("new@example.com");
    expect(body.acceptUrl).toMatch(/\/accept-invite\//);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: re-inviting the same pending email returns the existing invite without re-sending", async () => {
    const org = await seedAdminOrg();
    const first = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "dup@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    const firstBody = await first.json();

    const second = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "dup@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.invitation.id).toBe(firstBody.invitation.id);
    expect(global.fetch).toHaveBeenCalledTimes(1); // not re-sent
  });

  it("403s a non-admin (viewer) trying to invite", async () => {
    const org = await seedAdminOrg();
    await db.insert(memberships).values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("viewer_1", org.id),
        body: JSON.stringify({ email: "x@example.com", role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /invitations/:token/accept", () => {
  it("creates an active membership and marks the invite accepted", async () => {
    const org = await seedAdminOrg();
    const [invite] = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "invitee@example.com",
        role: "viewer",
        token: "tok_accept_1",
        status: "pending",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, {
        method: "POST",
        headers: authed("new_user"),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);

    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.clerkUserId, "new_user"));
    expect(membership).toMatchObject({ organizationId: org.id, role: "viewer", status: "active" });

    const [updatedInvite] = await db.select().from(invitations).where(eq(invitations.id, invite.id));
    expect(updatedInvite.status).toBe("accepted");
  });

  it("410s on an already-accepted invite", async () => {
    const org = await seedAdminOrg();
    const [invite] = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "used@example.com",
        role: "viewer",
        token: "tok_used",
        status: "accepted",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(410);
  });

  it("410s on an expired invite", async () => {
    const org = await seedAdminOrg();
    const [invite] = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "expired@example.com",
        role: "viewer",
        token: "tok_expired",
        status: "pending",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(410);
  });

  it("404s on an unknown token", async () => {
    const res = await invitationsRoutes.fetch(
      new Request("http://test/invitations/does-not-exist/accept", { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- invitations.routes`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Add `rateLimitByOrg` to the rate-limit middleware**

Append to `hono-worker/src/controllers/rate-limit.middleware.ts` (keep `rateLimitByIp` as-is):

```ts
// Same dual-mode/degrade contract as rateLimitByIp, keyed by the resolved
// organization instead of the caller's IP - protects a per-org resource
// (invite spam, CSV import cost) rather than a per-caller one.
export function rateLimitByOrg(limit: number, windowSeconds: number) {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | void> => {
    const redis = getRedis(c.env);
    if (!redis) {
      await next();
      return;
    }

    const orgId = c.get("orgId");
    if (!orgId) {
      await next();
      return;
    }

    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    });

    try {
      const { success } = await ratelimit.limit(orgId);
      if (!success) {
        return c.json({ error: { message: "Too many requests", statusCode: 429 } }, 429);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "rate limit check skipped", err: String(err) }));
    }

    await next();
  };
}
```

- [ ] **Step 4: Implement the schema**

`hono-worker/src/schemas/invitation.schema.ts`:

```ts
import { z } from "zod/v4";

export const InviteMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "viewer"]),
});
```

- [ ] **Step 5: Implement the controller**

`hono-worker/src/controllers/invitations.controller.ts`:

```ts
import type { Context } from "hono";
import type { z } from "zod/v4";
import { eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, users, invitations, memberships } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { sendInviteEmail } from "../lib/postmark.js";
import type { InviteMemberBody } from "../schemas/invitation.schema.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function acceptUrl(env: { ALLOWED_ORIGIN: string }, token: string): string {
  const origin = env.ALLOWED_ORIGIN || "http://localhost:5173";
  return `${origin}/accept-invite/${token}`;
}

type InviteIn = { in: { json: z.input<typeof InviteMemberBody> }; out: { json: z.infer<typeof InviteMemberBody> } };

export async function createInvitation(c: Context<AppBindings, string, InviteIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { email, role } = c.req.valid("json");

  try {
    const scoped = scopedDb(conn.db, orgId);
    const existing = await scoped.invitations.findPendingByEmail(email);
    if (existing) {
      return c.json({ invitation: existing, acceptUrl: acceptUrl(c.env, existing.token) }, 200);
    }

    const token = newToken();
    const [invite] = await conn.db
      .insert(invitations)
      .values({
        organizationId: orgId,
        email,
        role,
        token,
        status: "pending",
        invitedBy: userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();

    const [org] = await conn.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const [inviter] = await conn.db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);

    // Fire-and-forget: response doesn't wait on email delivery.
    c.executionCtx.waitUntil(
      sendInviteEmail(c.env, {
        to: email,
        orgName: org?.name ?? "your organization",
        inviterName: inviter?.name ?? "Someone",
        acceptUrl: acceptUrl(c.env, token),
      }),
    );

    return c.json({ invitation: invite, acceptUrl: acceptUrl(c.env, token) }, 201);
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function acceptInvitation(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const token = c.req.param("token");
  const userId = c.get("userId")!;

  try {
    const [invite] = await conn.db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
    if (!invite) {
      return c.json({ error: { message: "Invitation not found", statusCode: 404 } }, 404);
    }
    if (invite.status !== "pending" || invite.expiresAt.getTime() < Date.now()) {
      return c.json({ error: { message: "Invitation is no longer valid", statusCode: 410 } }, 410);
    }

    await conn.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ organizationId: invite.organizationId, clerkUserId: userId, role: invite.role, status: "active" })
        .onConflictDoUpdate({
          target: [memberships.organizationId, memberships.clerkUserId],
          set: { role: invite.role, status: "active" },
        });

      await tx.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invite.id));
    });

    return c.json({ organizationId: invite.organizationId, role: invite.role });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
```

- [ ] **Step 6: Implement the route**

`hono-worker/src/routes/invitations.routes.ts`:

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { rateLimitByOrg } from "../controllers/rate-limit.middleware.js";
import { InviteMemberBody } from "../schemas/invitation.schema.js";
import { createInvitation, acceptInvitation } from "../controllers/invitations.controller.js";

export const invitationsRoutes = new Hono<AppBindings>();

const validateInvite = zValidator("json", InviteMemberBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

invitationsRoutes.post(
  "/organizations/:orgId/invitations",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  rateLimitByOrg(20, 3600),
  validateInvite,
  createInvitation,
);
invitationsRoutes.post("/invitations/:token/accept", requireAuth, acceptInvitation);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd hono-worker && npm test -- invitations.routes`
Expected: PASS (7 tests)

- [ ] **Step 8: Commit**

```bash
git add hono-worker/src/controllers/rate-limit.middleware.ts hono-worker/src/schemas/invitation.schema.ts \
  hono-worker/src/controllers/invitations.controller.ts hono-worker/src/routes/invitations.routes.ts \
  hono-worker/src/routes/invitations.routes.test.ts
git commit -m "feat: invitations API (create idempotent+emailed, accept with expiry checks)"
```

---

### Task 10: Members API

**Files:**
- Create: `hono-worker/src/schemas/membership.schema.ts`
- Create: `hono-worker/src/controllers/members.controller.ts`
- Create: `hono-worker/src/routes/members.routes.ts`
- Create: `hono-worker/src/routes/members.routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `resolveOrg`, `requireRole("admin")`, `scopedDb`, `memberships`/`users`.
- Produces: `membersRoutes: Hono<AppBindings>` exposing `GET/PATCH/DELETE /organizations/:orgId/members[/:membershipId]` — Task 11 registers it.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/routes/members.routes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { membersRoutes } from "./members.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId, "content-type": "application/json" };
}

async function seedOrg() {
  const [org] = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  const rows = await db
    .insert(memberships)
    .values([
      { organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" },
      { organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" },
    ])
    .returning();
  return { org, admin: rows[0], viewer: rows[1] };
}

describe("GET /organizations/:orgId/members", () => {
  it("lists active members of the org", async () => {
    const { org } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members`, { headers: authed("admin_1", org.id) }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(2);
  });
});

describe("PATCH /organizations/:orgId/members/:membershipId", () => {
  it("changes a member's role", async () => {
    const { org, viewer } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${viewer.id}`, {
        method: "PATCH",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ role: "admin" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const [updated] = await db.select().from(memberships).where(eq(memberships.id, viewer.id));
    expect(updated.role).toBe("admin");
  });

  it("409s demoting the org's last admin", async () => {
    const { org, admin } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${admin.id}`, {
        method: "PATCH",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(409);
    const [unchanged] = await db.select().from(memberships).where(eq(memberships.id, admin.id));
    expect(unchanged.role).toBe("admin");
  });
});

describe("DELETE /organizations/:orgId/members/:membershipId", () => {
  it("soft-removes a member (status, not row deletion)", async () => {
    const { org, viewer } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${viewer.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(memberships).where(eq(memberships.id, viewer.id));
    expect(row).toBeDefined();
    expect(row.status).toBe("removed");
  });

  it("409s removing the org's last admin", async () => {
    const { org, admin } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${admin.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(409);
    const [row] = await db.select().from(memberships).where(eq(memberships.id, admin.id));
    expect(row.status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- members.routes`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the schema**

`hono-worker/src/schemas/membership.schema.ts`:

```ts
import { z } from "zod/v4";

export const UpdateMembershipRoleBody = z.object({
  role: z.enum(["admin", "viewer"]),
});
```

- [ ] **Step 4: Implement the controller**

`hono-worker/src/controllers/members.controller.ts`:

```ts
import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { memberships, users } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import type { UpdateMembershipRoleBody } from "../schemas/membership.schema.js";

export async function listMembers(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  try {
    const rows = await conn.db
      .select({ membership: memberships, user: users })
      .from(memberships)
      .leftJoin(users, eq(memberships.clerkUserId, users.clerkUserId))
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")));

    return c.json({ members: rows });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

type PatchRoleIn = {
  in: { json: z.input<typeof UpdateMembershipRoleBody> };
  out: { json: z.infer<typeof UpdateMembershipRoleBody> };
};

export async function updateMemberRole(c: Context<AppBindings, string, PatchRoleIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");
  const { role } = c.req.valid("json");

  try {
    const [target] = await conn.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) {
      return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
    }

    if (target.role === "admin" && role !== "admin") {
      const adminCount = await scopedDb(conn.db, orgId).memberships.countActiveAdmins();
      if (adminCount <= 1) {
        return c.json(
          { error: { message: "Organization must have at least one admin", statusCode: 409 } },
          409,
        );
      }
    }

    await conn.db.update(memberships).set({ role }).where(eq(memberships.id, membershipId));
    return c.json({ ok: true });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function removeMember(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");

  try {
    const [target] = await conn.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) {
      return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
    }

    if (target.role === "admin") {
      const adminCount = await scopedDb(conn.db, orgId).memberships.countActiveAdmins();
      if (adminCount <= 1) {
        return c.json(
          { error: { message: "Organization must have at least one admin", statusCode: 409 } },
          409,
        );
      }
    }

    await conn.db.update(memberships).set({ status: "removed" }).where(eq(memberships.id, membershipId));
    return c.json({ ok: true });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
```

- [ ] **Step 5: Implement the route**

`hono-worker/src/routes/members.routes.ts`:

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { UpdateMembershipRoleBody } from "../schemas/membership.schema.js";
import { listMembers, updateMemberRole, removeMember } from "../controllers/members.controller.js";

export const membersRoutes = new Hono<AppBindings>();

const validatePatchRole = zValidator("json", UpdateMembershipRoleBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

membersRoutes.get("/organizations/:orgId/members", requireAuth, resolveOrg, listMembers);
membersRoutes.patch(
  "/organizations/:orgId/members/:membershipId",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validatePatchRole,
  updateMemberRole,
);
membersRoutes.delete(
  "/organizations/:orgId/members/:membershipId",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  removeMember,
);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd hono-worker && npm test -- members.routes`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add hono-worker/src/schemas/membership.schema.ts hono-worker/src/controllers/members.controller.ts \
  hono-worker/src/routes/members.routes.ts hono-worker/src/routes/members.routes.test.ts
git commit -m "feat: members API (list, role change, soft-remove with last-admin guard)"
```

---

### Task 11: Wire routes into the app + cross-tenant isolation end-to-end test

**Files:**
- Modify: `hono-worker/src/index.ts`
- Create: `hono-worker/src/index.test.ts`

**Interfaces:**
- Consumes: every route module from Tasks 7–10.
- Produces: the fully assembled `app` default export, exercised end-to-end.

- [ ] **Step 1: Write the failing test**

`hono-worker/src/index.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../test-utils/db.js";
import app from "./index.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
  vi.restoreAllMocks();
  global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${userId}`, "content-type": "application/json" };
  if (orgId) headers["X-Org-Id"] = orgId;
  return headers;
}

describe("cross-tenant isolation, end to end", () => {
  it("a member of org A cannot read org B's members even with a valid token", async () => {
    const createA = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("user_a"),
        body: JSON.stringify({ name: "Org A" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const orgA = (await createA.json()).organization;

    const createB = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("user_b"),
        body: JSON.stringify({ name: "Org B" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const orgB = (await createB.json()).organization;

    // user_a, a real member of org A, tries org B's member list using org B's id.
    const res = await app.fetch(
      new Request(`http://test/api/organizations/${orgB.id}/members`, {
        headers: authed("user_a", orgB.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);

    // Sanity: user_a *can* read org A's members.
    const okRes = await app.fetch(
      new Request(`http://test/api/organizations/${orgA.id}/members`, {
        headers: authed("user_a", orgA.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(okRes.status).toBe(200);
  });

  it("invite -> accept -> membership flow works end to end", async () => {
    const createRes = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("admin_1"),
        body: JSON.stringify({ name: "ACME" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const org = (await createRes.json()).organization;

    const inviteRes = await app.fetch(
      new Request(`http://test/api/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "new@example.com", role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const invite = (await inviteRes.json()).invitation;

    const acceptRes = await app.fetch(
      new Request(`http://test/api/invitations/${invite.token}/accept`, {
        method: "POST",
        headers: authed("new_user"),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(acceptRes.status).toBe(200);

    const listRes = await app.fetch(
      new Request("http://test/api/organizations", { headers: authed("new_user") }),
      testEnv(), testExecutionCtx(),
    );
    const orgs = (await listRes.json()).organizations;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].organization.id).toBe(org.id);
    expect(orgs[0].role).toBe("viewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hono-worker && npm test -- index.test`
Expected: FAIL — the new routes aren't mounted yet, so `/api/organizations` 404s.

- [ ] **Step 3: Register the new routes**

`hono-worker/src/index.ts`:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings } from "./lib/context.js";
import { onError, notFound } from "./controllers/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { exampleRoutes } from "./routes/example.routes.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { organizationsRoutes } from "./routes/organizations.routes.js";
import { invitationsRoutes } from "./routes/invitations.routes.js";
import { membersRoutes } from "./routes/members.routes.js";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  c.set("reqId", crypto.randomUUID());
  await next();
});

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN;
      if (c.env.NODE_ENV !== "production") return origin ?? "*";
      return allowed && origin === allowed ? origin : "";
    },
  }),
);

app.onError(onError);
app.notFound(notFound);

app.get("/", (c) => c.json({ name: "swades-hackathon-worker", status: "ok" }));

app.route("/api", healthRoutes);
app.route("/api", exampleRoutes);
app.route("/api", webhooksRoutes);
app.route("/api", organizationsRoutes);
app.route("/api", invitationsRoutes);
app.route("/api", membersRoutes);

export default app;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hono-worker && npm test -- index.test`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full test suite**

Run: `cd hono-worker && npm test`
Expected: PASS — every test file from Tasks 2, 4, 5, 6, 7, 8, 9, 10, 11 (30+ tests total).

- [ ] **Step 6: Commit**

```bash
git add hono-worker/src/index.ts hono-worker/src/index.test.ts
git commit -m "feat: wire webhook/organizations/invitations/members routes into the app; add cross-tenant e2e test"
```

---

## Self-Review Notes

**Spec coverage:** §3 schema (Task 2), §4 identity-sync/org/member/invitation routes (Tasks 7–10), §5 auth flow's `resolveOrg`/`requireRole`/idempotency/expiry/last-admin rules (Tasks 5, 9, 10), Postmark fire-and-forget (Task 6), rate limiting on invitations (Task 9's `rateLimitByOrg`), env vars (Task 3). Not covered by this plan (by design — later plans): employees/salary/CSV/analytics/audit-log APIs (§4's salary-management table, §8's seed script) and the entire frontend (§6–§8) — those are Plans 2–4 per the decomposition agreed at the start of this planning session.

**Placeholder scan:** none found — every code block is the actual content to write, no TBD/"handle appropriately" phrasing.

**Type consistency checked:** `scopedDb(db: Db, organizationId: string)` signature is identical across Task 4's implementation and Tasks 9/10's call sites. `resolveOrg`/`requireRole` names and `c.get("orgId")`/`c.get("orgRole")` usage match Task 5's implementation everywhere they're consumed (Tasks 8 doesn't use them since `/organizations` itself has no org context yet; Tasks 9, 10, 11 do). `testEnv()`/`testDb()`/`truncateAll()`/`testExecutionCtx()` signatures from Task 2 are used identically in every subsequent test file.

**Correctness pass caught and fixed two bugs before handoff:** every `app.fetch(request, env)` call that reaches a handler doing `c.executionCtx.waitUntil(...)` (nearly all of them) was missing the required third `ExecutionContext` argument — Hono throws `"This context has no ExecutionContext"` without it. Added `testExecutionCtx()` to the harness and passed it at all ~35 call sites. Also, Task 7's webhook test originally signed test payloads via `svix`'s `Webhook.sign()`, whose exact return shape wasn't something to assume — replaced with a manual HMAC-SHA256 implementation of Svix's documented signing scheme (`id.timestamp.payload` → base64 HMAC, `v1,` prefix), which is what `Webhook.verify()` actually checks regardless of the signing helper's API.
