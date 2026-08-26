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
  status: varchar("status", { length: 20 }).notNull().default("active"), // invited | active
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
endpoints paginated (`limit`/`cursor`), errors in the shared `{ error: {
message, statusCode } }` shape. Every route below except the org-management
ones runs behind `requireAuth` + `resolveOrg` (§5) — `orgId`/`orgRole` come
from the resolved membership, never from client input.

**Organizations & membership** (no `X-Org-Id` needed except where noted):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /organizations | requireAuth | Create an org; creator becomes its first `admin` membership |
| GET | /organizations | requireAuth | List organizations the current user is a member of |
| GET | /organizations/:orgId/members | resolveOrg | List members of the active org |
| POST | /organizations/:orgId/invitations | resolveOrg + admin | Create an invitation (email, role); returns the shareable accept link |
| POST | /invitations/:token/accept | requireAuth | Accept an invite → creates/activates a membership for the current user |
| PATCH | /organizations/:orgId/members/:membershipId | resolveOrg + admin | Change a member's role |
| DELETE | /organizations/:orgId/members/:membershipId | resolveOrg + admin | Remove a member |

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
1. User signs up/in through a **custom-built UI** (our own form components —
   email/password + fields, not Clerk's hosted `<SignIn/>`/`<SignUp/>`),
   wired to Clerk's headless client (`@clerk/clerk-react`'s `useSignIn`/
   `useSignUp` hooks driving `signIn.create`/`signUp.create` and the
   verification-code step) so the visual design stays entirely ours while
   Clerk still owns credential storage, verification, and session issuance.
2. `GET /organizations` returns the orgs they belong to. Zero → onboarding
   gate: *create an organization* (`POST /organizations`, caller becomes its
   `admin` membership) or *redeem an invite link*.
3. An `admin` invites by email (`POST /organizations/:orgId/invitations`) →
   an `invitations` row with a random token and a `pending` status is
   created; the response includes a `/accept-invite/:token` link to share.
   Visiting it while signed in and calling `POST /invitations/:token/accept`
   creates (or activates) that user's `memberships` row for that org.
4. The frontend keeps the user's active `organizationId` (picked from a
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

## 6. Frontend

`frontend/` — React + Vite + Tailwind + shadcn/ui, deployed to Cloudflare
Pages.

**Theming:** shadcn/ui in CSS-variable mode, styled with a **tweakcn**
theme — a `globals.css` with the standard shadcn CSS-variable set
(`--background`, `--primary`, `--radius`, etc. for both light and dark)
generated from tweakcn.com and dropped in as-is, rather than hand-tuning
Tailwind config colors. Keeps the visual system consistent and swappable
without touching component code.

**Pages:**
- Sign-in / sign-up — fully custom UI (our own shadcn-styled form
  components: email/password fields, verification-code step), built on
  Clerk's headless `useSignIn`/`useSignUp` hooks — **no Clerk hosted
  `<SignIn/>`/`<SignUp/>` components** anywhere in the app. Clerk stays
  the identity/session backend only; every pixel is ours.
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

The `viewer` role hides every mutating control (buttons, forms, the Members
page's invite/edit actions) client-side *and* the API rejects the write
server-side regardless — client-side hiding is UX, not the security
boundary.

## 7. Seeding

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

## 8. Testing

Vitest, fast and deterministic — no network calls, no LLM.

- **Backend unit tests:** currency normalization math, CSV row validation,
  the "current salary" query builder, analytics aggregation logic.
- **Backend route tests:** hit the Hono app against a local test database
  (pglite or a disposable Postgres), covering auth gating (admin vs viewer),
  validation errors, soft-delete behavior, transactional audit-log writes,
  invite creation → accept → membership activation, and — the one that
  matters most for a multi-tenant system — that a member of org A gets 403
  (not org B's data) when calling org B's endpoints with org B's id and
  their own valid session token.
- **Frontend component tests:** Vitest + React Testing Library for the
  employee table (filtering/pagination), salary-history timeline, and CSV
  import dialog (success + per-row-error rendering).

## 9. Deployment

- `hono-worker` → `wrangler deploy`, `HYPERDRIVE` bound to the Supabase
  Postgres connection string, `CLERK_SECRET_KEY` set as a secret.
- `frontend` → Cloudflare Pages, `VITE_CLERK_PUBLISHABLE_KEY` and the
  deployed Worker's URL as build-time env vars.
- Deployed URL + a short demo video are the assessment's stated readiness
  bar — captured as a follow-up step once the app is functional, not part of
  this spec's implementation.

## 10. Out-of-repo housekeeping

- Delete `fastify-api/` (superseded scaffold, unused by this feature).
- The old `sessions`/`chunks` schema in `hono-worker/src/models/schema.ts`
  and its `sessions.routes.ts`/`sessions.controller.ts` are from the earlier
  hackathon scenario and are unused by salary management — removed as part
  of the implementation plan, not left alongside the new schema.
