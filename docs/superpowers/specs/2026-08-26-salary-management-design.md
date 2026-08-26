# Salary Management Software — Design Spec

Date: 2026-08-26 (revised 2026-08-27: custom multi-tenant organizations)
Status: Approved for planning

## 1. Requirements (one-pager)

**Goal:** Give any org's HR Manager a web app to manage salary data for
thousands of employees across multiple countries, replacing the current
Excel-based process, and to answer questions about how the org pays people.
The reference deployment is seeded for ACME (10,000 employees), but the
system is multi-tenant: any number of organizations can use it, each with
its own isolated employees/salaries/members.

**User persona:** HR Manager, a member of exactly one or more organizations,
with two permission levels per organization — see §5.

**In scope:**
- Employee records (profile, department, country, level, employment status),
  scoped to one organization.
- Salary records as an append-only history (raises/adjustments never
  overwrite — every change is a new dated row), so "what did this person earn
  in 2024" is answerable.
- Multi-currency salary storage, normalized to USD for cross-country
  analytics via a fixed FX-rate snapshot (no live FX dependency).
- An analytics dashboard answering the brief's "how does the org pay people"
  question: headcount, average/median salary, and total payroll cost,
  sliceable by country / department / level, computed live via SQL — no
  precomputed rollups, no LLM in the critical path (10k rows is trivially
  fast to aggregate on every request).
- CSV bulk import (the direct fix for "currently managed via Excel") and CSV
  export of the current filtered employee view.
- An audit log of every salary/employee mutation (actor, before/after,
  timestamp) — compliance-flavored, expected of software handling
  compensation data.
- **Custom multi-tenant organizations, built on our own tables — Clerk's
  Organization feature is off-limits.** Clerk provides identity only
  (credential storage, verification, session issuance), reached through a
  fully custom sign-in/sign-up UI (Clerk's headless hooks, not its hosted
  `<SignIn/>`/`<SignUp/>`/`<OrganizationSwitcher/>`/`<CreateOrganization/>`
  components). Org creation, membership, roles, and invitations are our own
  `organizations`/`memberships`/`invitations` tables and API — see §5.
- Role-gated access per organization: admin (read/write) vs viewer
  (read-only).

**Deliberately out of scope, and why:**
- *Employee self-service login.* Every persona here is HR staff; adding a
  second auth surface (per-employee row-level access control) is scope
  nothing so far has asked for.
- *Live FX rates / real payroll processing / tax calculation.* This is a
  salary *management* tool, not a payroll *processing* system — running
  payroll, computing taxes/deductions, and issuing payments are a different,
  much larger problem than "HR manager can see and edit salary data."
- *Natural-language chat over the data.* A dashboard answers "how do we pay
  people" deterministically and is fully testable; an LLM in that path adds
  non-determinism to a domain (compensation data) where a wrong answer is
  costly, for a capability nothing has explicitly requested.
- *Transactional invite emails.* Invitations are real rows with real tokens,
  but delivery is a copy/share-the-link flow, not an emailed message —
  wiring a transactional email provider is a clean, isolated follow-up, not
  required for the invite flow to function end-to-end.
- *Org chart / performance reviews / benefits.* Adjacent HR features not
  implied by "salary management."

## 2. Architecture

Two independently-deployed pieces in this repo, both on Cloudflare:

```
hono-worker/   Hono API on Cloudflare Workers, Postgres (Supabase) via
               Hyperdrive + Drizzle ORM, Clerk auth. Already scaffolded;
               extended with the salary-management schema/routes below.
frontend/      React + Vite + Tailwind + shadcn/ui, deployed to Cloudflare
               Pages. Calls the Worker's API with a Clerk session token.
```

Real-time SQL aggregation over precomputed rollups: at 10,000 rows a
`GROUP BY`/`percentile_cont` query is single-digit milliseconds in Postgres,
so a rollup table would only add staleness risk for no measurable benefit.

`fastify-api/` is unused scaffolding superseded by `hono-worker/` — deleted
as the first step of the implementation plan, not left to rot.

## 3. Data model

`hono-worker/src/models/schema.ts` (Drizzle, Postgres dialect). Replaces the
old chunking-pipeline `sessions`/`chunks` tables from the earlier hackathon
scenario, which are unused by this feature.

```ts
// --- Local mirror of Clerk identity, kept in sync via webhook ---
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

// --- Organizations, membership, invitations (custom, not Clerk Orgs) ---

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_organizations_slug").on(t.slug),
]);

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),             // admin | viewer
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | removed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_memberships_org_user").on(t.organizationId, t.clerkUserId),
  index("idx_memberships_user").on(t.clerkUserId),
]);

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  email: varchar("email", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),              // admin | viewer
  token: varchar("token", { length: 64 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | accepted | revoked
  invitedBy: varchar("invited_by", { length: 255 }).notNull(),  // Clerk user id
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_invitations_token").on(t.token),
  // Idempotency: one live invite per (org, email) at a time
  // (idempotency-checksums.md rule 3's upsert-over-insert principle).
  uniqueIndex("uq_invitations_org_email_pending")
    .on(t.organizationId, t.email)
    .where(sql`${t.status} = 'pending'`),
]);

// --- Salary-management domain, every row org-scoped ---

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  employeeNumber: varchar("employee_number", { length: 32 }).notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  country: varchar("country", { length: 2 }).notNull(),      // ISO-3166-1 alpha-2
  department: varchar("department", { length: 100 }).notNull(),
  jobTitle: varchar("job_title", { length: 150 }).notNull(),
  level: varchar("level", { length: 20 }).notNull(),          // e.g. "L3", "M2"
  employmentStatus: varchar("employment_status", { length: 20 })
    .notNull().default("active"),                             // active | terminated
  hireDate: date("hire_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_employees_org_employee_number").on(t.organizationId, t.employeeNumber),
  index("idx_employees_org_country").on(t.organizationId, t.country),
  index("idx_employees_org_department").on(t.organizationId, t.department),
  index("idx_employees_org_status").on(t.organizationId, t.employmentStatus),
]);

export const salaryRecords = pgTable("salary_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),      // ISO-4217
  effectiveDate: date("effective_date").notNull(),
  reason: varchar("reason", { length: 30 }).notNull(),         // hire | raise | adjustment | correction
  createdBy: varchar("created_by", { length: 255 }).notNull(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_salary_org_employee").on(t.organizationId, t.employeeId),
  index("idx_salary_org_employee_effective").on(t.organizationId, t.employeeId, t.effectiveDate),
]);

// Global reference data, deliberately not org-scoped — exchange rates are
// an objective fact, not tenant data.
export const fxRates = pgTable("fx_rates", {
  currency: varchar("currency", { length: 3 }).primaryKey(),
  rateToUsd: numeric("rate_to_usd", { precision: 12, scale: 6 }).notNull(),
  asOfDate: date("as_of_date").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  actorClerkUserId: varchar("actor_clerk_user_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),         // create | update | delete
  entityType: varchar("entity_type", { length: 30 }).notNull(),// employee | salary_record
  entityId: uuid("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_audit_org_entity").on(t.organizationId, t.entityType, t.entityId),
]);
```

"Current salary" for an employee = latest `salary_records` row by
`effective_date` (`DISTINCT ON (employee_id) ... ORDER BY employee_id,
effective_date DESC`), never an overwritten column — this is what makes
history free and correct.

Employee/salary mutations run inside `db.transaction(...)`: the row
write and its `audit_log` insert commit together or not at all
(database-indexing.md rule 4). Deletes are soft (`employment_status =
'terminated'`) — never a hard `DELETE`, so history and audit trail survive.

Every one of these queries is reached through the `scopedDb(organizationId)`
helper described in §5 — the `organization_id` filter is applied by that
helper, not hand-written per route, so a route can't accidentally omit it.

## 4. API surface

All routes under `/api`, zod-validated body/query/params, all list
endpoints paginated (`limit`/`cursor`, default `limit=25`, max `100` —
requests above the max are clamped, not rejected), errors in the shared
`{ error: { message, statusCode } }` shape. Every route below except the
org-management ones runs behind `requireAuth` + `resolveOrg` (§5) —
`orgId`/`orgRole` come from the resolved membership, never from client
input.

**CORS:** in production, `cors.plugin`/Hono's `cors()` middleware allows
only the deployed frontend's exact origin (`FRONTEND_URL` env var) — never
`origin: true` — per this repo's own `api-security.md` rule 7.

**Rate limiting** (`@upstash/ratelimit`, already a `hono-worker` dependency,
degrades to no-op if Upstash env vars are unset — env-vars.md rule 4):
`POST /organizations/:orgId/invitations` and `POST /employees/import` get a
per-org sliding-window limit (invites: cheap to spam and each one is a live
token; import: the heaviest single write this API does) — everything else
is normal authenticated CRUD with no external cost, so left unlimited per
`api-security.md` rule 1's own "only what costs money or is publicly
writable" scope.

**Identity sync** (public, signature-verified — not user-authenticated):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /webhooks/clerk | Svix signature | Upsert `users` row on `user.created`/`user.updated` |

**Organizations & membership** (no `X-Org-Id` needed except where noted):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /organizations | requireAuth | Create an org; creator becomes its first `admin` membership |
| GET | /organizations | requireAuth | List organizations the current user is a member of |
| GET | /organizations/:orgId/members | resolveOrg | List members of the active org |
| POST | /organizations/:orgId/invitations | resolveOrg + admin | Create an invitation (email, role); returns the shareable accept link |
| POST | /invitations/:token/accept | requireAuth | Accept an invite → creates/activates a membership for the current user |
| PATCH | /organizations/:orgId/members/:membershipId | resolveOrg + admin | Change a member's role |
| DELETE | /organizations/:orgId/members/:membershipId | resolveOrg + admin | Soft-remove a member (status → removed, never a hard row delete — consistent with employees' soft-delete and keeps audit_log's actor references valid) |

**Salary management** (all require `resolveOrg`; write routes require `admin`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /employees | member | Paginated, filterable (country, department, status, search) list |
| GET | /employees/:id | member | Profile + salary history |
| POST | /employees | admin | Create employee (+ initial salary record) |
| PUT | /employees/:id | admin | Update profile fields |
| DELETE | /employees/:id | admin | Soft-delete (status → terminated) |
| POST | /employees/:id/salary | admin | Append a new salary record |
| POST | /employees/import | admin | CSV bulk upload, chunked transactional upsert, per-row error report |
| GET | /employees/export | member | CSV export of current filtered view |
| GET | /analytics/summary | member | Headcount/avg/median/total-cost-USD, sliced by country/department/level |
| GET | /audit-log | member | Paginated, filterable by entity |

CSV import: parsed in-memory (bounded size — a few thousand rows, not the
5k-RPS streaming scenario from the earlier hackathon context), validated
row-by-row with zod, upserted in transactional batches of ~500 keyed on
`(organization_id, employee_number)`, response reports `{ created, updated,
failed: [{ row, error }] }`.

## 5. Auth & organizations

Clerk provides identity only — sign-up (public), sign-in, session
verification. **Organizations, membership, and roles are entirely our own**
(`organizations`/`memberships`/`invitations` tables, §3), not Clerk's
Organization primitive.

**Flow:**
1. User signs up/in through a **custom-built UI** — two methods, both
   driven by Clerk's headless client, never Clerk's hosted components:
   - *Email:* our own form (email/password + name fields), wired to
     `useSignIn`/`useSignUp`'s `signIn.create`/`signUp.create` and the
     email verification-code step.
   - *Google:* a "Continue with Google" button we build (shadcn `Button`,
     our icon/label) that calls `signIn.authenticateWithRedirect({
     strategy: "oauth_google", redirectUrl: "/sso-callback",
     redirectUrlComplete: "/dashboard" })` — Clerk handles the Google OAuth
     handshake itself (required, cannot be reimplemented), but every pixel
     the user sees before and after the redirect is still ours; `/sso-
     callback` is our own thin route that finishes the handshake via
     `useAuthCallback`/`handleRedirectCallback` and forwards on.
2. **On successful auth (either method), the app queries `GET
   /organizations`** and redirects: zero orgs → the onboarding gate
   (create org / redeem invite link); one or more → straight to
   `/dashboard` for the first (or last-used, from `localStorage`) org. This
   redirect is the one required outcome of a successful sign-in — a user
   never lands back on the sign-in page or a blank shell after
   authenticating.
3. Whenever Clerk fires `user.created` or `user.updated` (covers both
   email and Google sign-up, since Google-sourced name/avatar/email arrive
   through the same webhook event), `POST /webhooks/clerk` verifies the
   Svix signature header (api-security.md rule 6 — an unverified webhook is
   an open write endpoint) and upserts the `users` row — this is the
   "proper data storage" for identity: name/email/avatar live in our DB,
   not re-fetched from Clerk's API on every member-list render.
4. `GET /organizations` returns the orgs they belong to. Zero → onboarding
   gate: *create an organization* (`POST /organizations`, caller becomes its
   `admin` membership) or *redeem an invite link*.
5. An `admin` invites by email (`POST /organizations/:orgId/invitations`).
   **Idempotent, not error-on-duplicate:** if a `pending` invite already
   exists for that `(org, email)` (the unique partial index from §3), the
   route returns the *existing* invite's link instead of a 409 — a
   double-click or retry re-shares the same link rather than failing
   (idempotency.md rule 3's upsert-over-insert principle). The created row
   gets a `pending` status, a random token, and `expiresAt` (7 days out).
   `POST /invitations/:token/accept`:
   - 404 if the token doesn't exist, 410 Gone if `status != 'pending'` or
     `expiresAt` has passed (an already-accepted or expired token is not a
     valid invite, and both are distinguishable from "never existed").
   - otherwise creates (or reactivates, if this user had left) a
     `memberships` row for the token's org/role and flips the invitation to
     `accepted` in the same transaction — this makes accept itself
     idempotent: a retried accept call on an already-accepted invite still
     hits the "not pending" branch and returns cleanly rather than double-
     creating a membership (the `(organization_id, clerk_user_id)` unique
     constraint would also catch it, but the explicit status check gives a
     clean 410 instead of a raw constraint-violation 500).
6. **An organization can never be left with zero admins.** `PATCH`/`DELETE`
   on a membership checks the org's current admin count first; demoting or
   removing the last remaining `admin` is rejected with 409 ("organization
   must have at least one admin"). Without this check, a single mis-click
   permanently locks an organization's data behind a role no one holds —
   there's no super-admin escape hatch in this design, so the guard has to
   be structural, not a support workaround.
7. The frontend keeps the user's active `organizationId` (picked from a
   simple org switcher) in `localStorage` and sends it as an `X-Org-Id`
   header on every API call.

**Middleware (`hono-worker/src/controllers/auth.middleware.ts`):**
- `requireAuth` (existing) — verifies the Clerk bearer token, sets `userId`.
  Unchanged.
- `resolveOrg` (new) — reads `X-Org-Id`, looks up
  `memberships WHERE organization_id = ? AND clerk_user_id = ? AND status =
  'active'`; 403 `"Not a member of this organization"` on no match. Sets
  `orgId` and `orgRole` from that row. This is the *only* place org access
  is authorized — org id is never trusted from a body/query/param, only
  from this DB-verified lookup, mirroring the tenant-isolation principle
  already codified in this repo's `swades-eval-runner.md` rules.
- `requireRole("admin")` (new) — 403 unless `orgRole === "admin"`.

**Query isolation:** a `scopedDb(orgId)` helper (thin wrapper around the
Drizzle client) pre-applies `WHERE organization_id = orgId` for every
domain-table query, so route handlers can't forget it — the alternative
(hand-writing the filter in every handler) is exactly the kind of mistake
that produces cross-tenant data leaks under time pressure.

**Middleware shape** (`hono-worker/src/controllers/auth.middleware.ts`),
composed per route rather than globally, so read routes stay two-deep and
write routes three-deep:

```ts
// requireAuth (existing) -> sets c.set("userId", claims.sub)

export async function resolveOrg(c: Context<AppBindings>, next: Next) {
  const orgId = c.req.header("X-Org-Id");
  if (!orgId) return c.json({ error: { message: "X-Org-Id header required", statusCode: 400 } }, 400);

  const db = getDb(c.env);
  if (!db) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const [membership] = await db.db.select().from(memberships).where(
    and(
      eq(memberships.organizationId, orgId),
      eq(memberships.clerkUserId, c.get("userId")),
      eq(memberships.status, "active"),
    ),
  ).limit(1);

  if (!membership) {
    return c.json({ error: { message: "Not a member of this organization", statusCode: 403 } }, 403);
  }
  c.set("orgId", orgId);
  c.set("orgRole", membership.role); // "admin" | "viewer"
  await next();
}

export function requireRole(role: "admin") {
  return async (c: Context<AppBindings>, next: Next) => {
    if (c.get("orgRole") !== role) {
      return c.json({ error: { message: "Forbidden", statusCode: 403 } }, 403);
    }
    await next();
  };
}

// Route composition:
// app.get("/employees", requireAuth, resolveOrg, listEmployees)
// app.post("/employees", requireAuth, resolveOrg, requireRole("admin"), createEmployee)
```

`resolveOrg` is one indexed lookup (`idx_memberships_user`, plus the
`(organization_id, clerk_user_id)` unique constraint doubling as a lookup
index) — negligible latency cost per request for the isolation guarantee it
buys.

## 6. Validation strategy (shared zod schemas)

One zod schema per resource, defined once in `hono-worker/src/schemas/*.ts`
(e.g. `employee.schema.ts` exporting `CreateEmployeeSchema`,
`UpdateEmployeeSchema`, `AddSalaryRecordSchema`, `InviteMemberSchema`) and
re-exported for the frontend to import directly — the repo stays a single
TypeScript project boundary-wise (Worker + Vite app both consume the same
`zod/v4` schema module), so a validation rule (e.g. "salary amount must be a
positive number with at most 2 decimal places", "country must be one of
these ISO codes", "employee_number matches `^[A-Z]{2,4}-\d{4,6}$`") is
written exactly once and can never drift between client and server.

- **Backend:** `@hono/zod-validator`'s `zValidator("json", CreateEmployeeSchema)`
  on the route — server-side validation is the actual security boundary
  (validation.md rule 1); this is non-negotiable regardless of what the
  frontend does.
- **Frontend:** `react-hook-form` + `@hookform/resolvers/zod`, passing the
  *same* schema straight into `zodResolver(CreateEmployeeSchema)` — field-
  level errors (`formState.errors.email`, etc.) render inline under each
  input as the user types/blurs, so a bad row is caught before the request
  ever leaves the browser, with the backend re-validating identically as
  the authoritative check.
- **CSV import** reuses the identical per-row schema (`CreateEmployeeSchema
  .safeParse(row)`), so a bulk-imported row is held to exactly the same
  rules as one entered by hand in the form — one validation source, three
  entry points (form, CSV, API-direct).

## 7. Frontend

`frontend/` — React + Vite + Tailwind + shadcn/ui, deployed to Cloudflare
Pages.

**Theming:** shadcn/ui in CSS-variable mode (Tailwind v4 `@theme inline`),
styled with a specific tweakcn theme — a near-white light palette (`--radius:
0.125rem`, tighter/sharper corners than the default), a true-black dark
palette with a blue `--chart-1`/`--sidebar-primary` accent, and a slight
negative letter-spacing (`--tracking-normal: -0.015em`) applied at the
`body` level. The exact file below is the theme, saved verbatim to
`frontend/src/styles/globals.css` and imported once at the app root — no
hand-tuned Tailwind config colors, no per-component overrides:

```css
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
  --background: #ffffff;
  --foreground: #0f172a;
  --card: #ffffff;
  --card-foreground: #0f172a;
  --popover: #ffffff;
  --popover-foreground: #020617;
  --primary: #334155;
  --primary-foreground: #f8fafc;
  --secondary: #f1f5f9;
  --secondary-foreground: #0f172a;
  --muted: #f8fafc;
  --muted-foreground: #64748b;
  --accent: #f1f5f9;
  --accent-foreground: #0f172a;
  --destructive: #e11d48;
  --destructive-foreground: #ffffff;
  --border: #e2e8f0;
  --input: #e1e7ef;
  --ring: #1e293b;
  --chart-1: #334155;
  --chart-2: #10b981;
  --chart-3: #f59e0b;
  --chart-4: #6366f1;
  --chart-5: #64748b;
  --sidebar: #f8fafc;
  --sidebar-foreground: #334155;
  --sidebar-primary: #0f172a;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #f1f5f9;
  --sidebar-accent-foreground: #0f172a;
  --sidebar-border: #e2e8f0;
  --sidebar-ring: #1e293b;
  --font-sans: "Inter", system-ui, sans-serif;
  --font-serif: "Georgia", serif;
  --font-mono: "JetBrains Mono", monospace;
  --radius: 0.125rem;
  --shadow-x: 0px;
  --shadow-y: 0px;
  --shadow-blur: 0px;
  --shadow-spread: 0px;
  --shadow-opacity: 0;
  --shadow-color: #000000;
  --shadow-2xs: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-xs: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-sm: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow-md: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 2px 4px -1px hsl(0 0% 0% / 0.00);
  --shadow-lg: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 4px 6px -1px hsl(0 0% 0% / 0.00);
  --shadow-xl: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 8px 10px -1px hsl(0 0% 0% / 0.00);
  --shadow-2xl: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
  --tracking-normal: -0.015em;
  --spacing: 0.25rem;
}

.dark {
  --background: #020617;
  --foreground: #f8fafc;
  --card: #020617;
  --card-foreground: #f8fafc;
  --popover: #020617;
  --popover-foreground: #f8fafc;
  --primary: #f8fafc;
  --primary-foreground: #0f172a;
  --secondary: #1e293b;
  --secondary-foreground: #f8fafc;
  --muted: #0f172a;
  --muted-foreground: #94a3b8;
  --accent: #1e293b;
  --accent-foreground: #f8fafc;
  --destructive: #991b1b;
  --destructive-foreground: #f8fafc;
  --border: #1e293b;
  --input: #1e293b;
  --ring: #94a3b8;
  --chart-1: #3b82f6;
  --chart-2: #10b981;
  --chart-3: #f59e0b;
  --chart-4: #a855f7;
  --chart-5: #64748b;
  --sidebar: #020617;
  --sidebar-foreground: #f1f5f9;
  --sidebar-primary: #3b82f6;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #1e293b;
  --sidebar-accent-foreground: #f1f5f9;
  --sidebar-border: #1e293b;
  --sidebar-ring: #3b82f6;
  --font-sans: "Inter", system-ui, sans-serif;
  --font-serif: "Georgia", serif;
  --font-mono: "JetBrains Mono", monospace;
  --radius: 0.125rem;
  --shadow-x: 0px;
  --shadow-y: 0px;
  --shadow-blur: 0px;
  --shadow-spread: 0px;
  --shadow-opacity: 0;
  --shadow-color: #000000;
  --shadow-2xs: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-xs: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
  --shadow-sm: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 1px 2px -1px hsl(0 0% 0% / 0.00);
  --shadow-md: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 2px 4px -1px hsl(0 0% 0% / 0.00);
  --shadow-lg: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 4px 6px -1px hsl(0 0% 0% / 0.00);
  --shadow-xl: 0px 0px 0px 0px hsl(0 0% 0% / 0.00), 0px 8px 10px -1px hsl(0 0% 0% / 0.00);
  --shadow-2xl: 0px 0px 0px 0px hsl(0 0% 0% / 0.00);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --shadow-2xs: var(--shadow-2xs);
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);
  --shadow-2xl: var(--shadow-2xl);

  --tracking-tighter: calc(var(--tracking-normal) - 0.05em);
  --tracking-tight: calc(var(--tracking-normal) - 0.025em);
  --tracking-normal: var(--tracking-normal);
  --tracking-wide: calc(var(--tracking-normal) + 0.025em);
  --tracking-wider: calc(var(--tracking-normal) + 0.05em);
  --tracking-widest: calc(var(--tracking-normal) + 0.1em);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
    letter-spacing: var(--tracking-normal);
  }
}
```

**Pages:**
- Sign-in / sign-up — fully custom UI (our own shadcn-styled form
  components: email/password fields, verification-code step, plus a
  "Continue with Google" button) built on Clerk's headless `useSignIn`/
  `useSignUp` hooks — **no Clerk hosted `<SignIn/>`/`<SignUp/>`
  components** anywhere in the app. Clerk stays the identity/session
  backend only; every pixel is ours. Successful auth redirects to
  `/dashboard` (or the onboarding gate) per §5 step 2.
- `/sso-callback` — thin route that completes the Google OAuth redirect
  and forwards to the same post-auth redirect logic as email sign-in.
- Onboarding gate — shown whenever there's no active organization: create
  one, or paste/open an invite link. Nothing past this screen is reachable
  without an active org.
- Org switcher — a simple dropdown (custom-built, not a Clerk component) of
  the user's organizations; selecting one sets the `X-Org-Id` sent on every
  request.
- Members — admin-only page: list members + pending invitations, invite by
  email/role, change a member's role, remove a member.
- Dashboard — summary cards (headcount, avg/median salary, total cost)
  + breakdown charts by country/department, backed by `/analytics/summary`.
- Employees — filterable/searchable/paginated table (shadcn `Table` +
  `DataTable` pattern), import/export buttons (admin-only for import).
- Employee detail — profile + salary-history timeline; "add salary record"
  form visible only to `admin`.
- Audit log — paginated table of changes.

Every form (sign-in/sign-up, create org, invite member, employee create/
edit, add salary record) is a `react-hook-form` instance with
`zodResolver(<ThatResource'sSchema>)` from §6 — consistent inline
field-level errors everywhere, no hand-rolled validation logic in a single
component.

The `viewer` role hides every mutating control (buttons, forms, the Members
page's invite/edit actions) client-side *and* the API rejects the write
server-side regardless — client-side hiding is UX, not the security
boundary.

## 8. Data fetching, mutations & UI feedback

**TanStack Query is the only server-state layer** — no `useEffect` + manual
`fetch`, no component-local "loading" booleans. Every read is a `useQuery`,
every write is a `useMutation`.

**Query keys are org-scoped first, always:** `["employees", orgId, {
country, department, status, search, sort, page }]`,
`["analytics-summary", orgId]`, `["members", orgId]`, `["audit-log", orgId,
{ page }]`. `orgId` as the leading key segment isn't cosmetic — it's what
stops a stale cache entry from another organization flashing on screen for
a moment after switching orgs in the switcher, the client-side mirror of
the server's own tenant-isolation discipline (§5). Switching the active org
doesn't need a manual `queryClient.clear()`; new keys naturally miss the
cache and refetch under the new `X-Org-Id`.

**Filter/sort/pagination state lives in the URL** (search params), not
component state — shareable/bookmarkable, and it's what feeds the query key
directly. The *server* does the actual filtering/sorting/paginating
(§4's `limit`/`cursor` + filter params); TanStack Query's job is caching,
deduping, and revalidating each distinct page/filter combination, never
fetching a full list and slicing it client-side (that would silently
reintroduce the unbounded-list problem §4 already ruled out).

**Mutations** (create/update/soft-delete employee, add salary record, CSV
import, invite member, accept invite, change/remove member role, create
org): plain `useMutation` + `invalidateQueries` on success — **not**
optimistic updates. For compensation data, a wrong optimistic flash that
then reverts is worse than a half-second loading state; this is a
deliberate YAGNI call, not an oversight.

**Toasts** (shadcn's `sonner`-based `<Toaster/>`, mounted once at the app
root): every mutation's `onSuccess`/`onError` fires exactly one toast —
success (create/update/import-complete/invite-sent/role-changed), a
distinct "removed" wording for soft-deletes (employee terminated, member
removed, invite revoked — same toast variant, different copy so a delete
doesn't read identically to an edit), and a destructive-variant toast on
`onError` whose message is the server's actual zod-derived error (§6),
never a generic "Something went wrong" — matches this repo's own
`error-handling-logging.md` rule 4 (4xx messages specific enough to act on).

**Loading/error states:** shadcn `Skeleton` rows for table loading
(`isPending`), not a spinner — better perceived performance for a table the
user is about to scan anyway; `isError` renders an inline retry state, not
a full-page crash.

**Destructive actions get a confirm step:** every soft-delete/remove
(terminate employee, remove member, revoke invitation) opens a shadcn
`AlertDialog` before the mutation fires — no bare button wired directly to
a destructive call.

**shadcn setup:** `components.json` with `style: "new-york"`, `cssVariables:
true`, base color mapped from the tweakcn theme's own tokens (§7) rather
than shadcn's default palette. Components installed via `npx shadcn add`:
`button`, `input`, `label`, `form` (the `react-hook-form` wrapper, §6),
`table`, `dialog`, `alert-dialog`, `dropdown-menu`, `select`, `badge`,
`card`, `tabs`, `avatar`, `skeleton`, `sonner`, `separator`, `pagination`.

## 9. Seeding

`hono-worker/scripts/seed.ts`, run with `tsx` against `DATABASE_URL`
directly (same pattern `drizzle-kit` already uses, bypassing Hyperdrive —
migrations/seeding are a deploy-time concern, not a per-request one).
Creates two `organizations` rows to make tenant isolation visible in the
demo, not just claimed:
- **ACME Corp** — 10,000 employees spread across ~8 countries with
  country-appropriate currency and realistic salary bands, plus 1–3
  historical `salary_records` per employee (so history/analytics have real
  data to exercise).
- **Globex Inc** — ~25 employees, same shape, smaller — switching to it in
  the UI should show a completely different, much smaller dataset.

Seeds one `memberships` row per org (role `admin`) for a Clerk user id
passed as a script argument/env var (the developer's own Clerk account,
so the seeded orgs are immediately usable after sign-in), and seeds
`fx_rates` with a fixed snapshot (global, shared by both orgs).

**Shape** (`hono-worker/scripts/seed.ts`):

```ts
const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client, { schema });

async function seedOrg(name: string, slug: string, employeeCount: number, adminClerkUserId: string) {
  const [org] = await db.insert(organizations).values({ name, slug }).returning();

  await db.insert(memberships).values({
    organizationId: org.id,
    clerkUserId: adminClerkUserId,
    role: "admin",
    status: "active",
  });

  for (const batch of chunk(generateEmployees(org.id, employeeCount), 500)) {
    // Each generated employee ships with 1-3 salaryRecords already
    // attached (hire + 0-2 raises), inserted in the same transaction
    // per batch so partial seed runs never leave an employee with zero
    // salary history.
    await db.transaction(async (tx) => {
      const inserted = await tx.insert(employees).values(batch.map((b) => b.employee)).returning();
      await tx.insert(salaryRecords).values(
        inserted.flatMap((e, i) => batch[i].salaryRecords.map((r) => ({ ...r, employeeId: e.id, organizationId: org.id }))),
      );
    });
  }
}

await db.insert(fxRates).values(FX_SNAPSHOT); // fixed, checked into the script
await seedOrg("ACME Corp", "acme", 10_000, process.env.SEED_ADMIN_CLERK_USER_ID!);
await seedOrg("Globex Inc", "globex", 25, process.env.SEED_ADMIN_CLERK_USER_ID!);
await client.end();
```

`generateEmployees` deterministically distributes employees across ~8
countries/currencies with country-appropriate salary bands (seeded RNG, not
`Math.random()`, so re-running produces the same dataset — useful for
tests and for reproducing a specific demo state).

## 10. Testing

Vitest, fast and deterministic — no network calls, no LLM.

- **Backend unit tests:** currency normalization math, CSV row validation,
  the "current salary" query builder, analytics aggregation logic.
- **Backend route tests:** hit the Hono app against a local test database
  (pglite or a disposable Postgres), covering auth gating (admin vs viewer),
  validation errors, soft-delete behavior, transactional audit-log writes,
  invite creation → accept → membership activation, and — the one that
  matters most for a multi-tenant system — that a member of org A gets 403
  (not org B's data) when calling org B's endpoints with org B's id and
  their own valid session token. Also: re-inviting an already-pending email
  returns the same invite rather than erroring; accepting an expired or
  already-accepted token returns 410; removing/demoting an org's last
  admin returns 409 and leaves the membership untouched.
- **Frontend component tests:** Vitest + React Testing Library for the
  employee table (filtering/pagination), salary-history timeline, and CSV
  import dialog (success + per-row-error rendering). Form tests assert
  that an invalid field (e.g. negative salary, malformed email) renders its
  `zodResolver`-produced error and blocks submit — same schema as the
  backend test for that resource, so the two suites are provably checking
  the same rule. Mutation tests (with a test `QueryClient`, mocked fetch)
  assert the right toast variant/message fires on success vs. error, that
  a destructive action is blocked until the `AlertDialog` is confirmed, and
  that switching the active org doesn't show stale data from the previous
  org's query cache (§8's org-scoped-query-key guarantee).

## 11. Deployment

- `hono-worker` → `wrangler deploy`, `HYPERDRIVE` bound to the Supabase
  Postgres connection string, `CLERK_SECRET_KEY` set as a secret.
- `frontend` → Cloudflare Pages, `VITE_CLERK_PUBLISHABLE_KEY` and the
  deployed Worker's URL as build-time env vars.
- Deployed URL + a short demo video are the assessment's stated readiness
  bar — captured as a follow-up step once the app is functional, not part of
  this spec's implementation.

**Env vars** (all optional/defaulted per `env-vars.md` — a missing one
degrades the affected feature, never crashes boot):

| Var | Used by |
|---|---|
| `HYPERDRIVE` (binding) / `DATABASE_URL` | DB connection (Worker / seed+migrations respectively) |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Auth verification, frontend Clerk client |
| `CLERK_WEBHOOK_SECRET` | Svix signature check on `/webhooks/clerk` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Frontend build-time |
| `FRONTEND_URL` | CORS allow-list origin |
| `UPSTASH_REDIS_REST_URL`/`TOKEN` | Rate limiting (invitations, CSV import) |
| `SEED_ADMIN_CLERK_USER_ID` | `seed.ts` only |

## 12. Out-of-repo housekeeping

- Delete `fastify-api/` (superseded scaffold, unused by this feature).
- The old `sessions`/`chunks` schema in `hono-worker/src/models/schema.ts`
  and its `sessions.routes.ts`/`sessions.controller.ts` are from the earlier
  hackathon scenario and are unused by salary management — removed as part
  of the implementation plan, not left alongside the new schema.
- **Manual Clerk Dashboard setup** (can't be scripted, done once before
  first run): enable the Google OAuth social-connection provider; register
  the `POST /webhooks/clerk` endpoint URL and copy its signing secret into
  `CLERK_WEBHOOK_SECRET`; add the Worker's deployed origin (and
  `localhost` for dev) to Clerk's allowed redirect URLs for
  `redirectUrlComplete: "/dashboard"` and `/sso-callback` to resolve.
