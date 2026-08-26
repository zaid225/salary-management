# Salary Management Software — Design Spec

Date: 2026-08-26
Status: Approved for planning

## 1. Requirements (one-pager)

**Goal:** Give ACME's HR Manager a web app to manage salary data for 10,000
employees across multiple countries, replacing the current Excel-based
process, and to answer questions about how the org pays people.

**User persona:** HR Manager (internal staff, two permission levels — see
§5).

**In scope:**
- Employee records (profile, department, country, level, employment status).
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
- Role-gated access: HR Admin (read/write) vs HR Viewer (read-only).

**Deliberately out of scope, and why:**
- *Employee self-service login.* The brief's only persona is the HR Manager;
  adding a second auth surface (per-employee row-level access control) is
  scope the assignment never asked for.
- *Multi-tenant / multi-company support.* The brief describes one org
  (ACME). Building Clerk-Organization-scoped isolation for hypothetical
  other tenants is speculative complexity for this assessment.
- *Live FX rates / real payroll processing / tax calculation.* This is a
  salary *management* tool, not a payroll *processing* system — running
  payroll, computing taxes/deductions, and issuing payments are a different,
  much larger problem than "HR manager can see and edit salary data."
- *Natural-language chat over the data.* A dashboard answers "how do we pay
  people" deterministically and is fully testable; an LLM in that path adds
  non-determinism to a domain (compensation data) where a wrong answer is
  costly, for a capability the brief didn't explicitly request.
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
export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  unique("uq_employees_employee_number").on(t.employeeNumber),
  index("idx_employees_country").on(t.country),
  index("idx_employees_department").on(t.department),
  index("idx_employees_status").on(t.employmentStatus),
]);

export const salaryRecords = pgTable("salary_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),      // ISO-4217
  effectiveDate: date("effective_date").notNull(),
  reason: varchar("reason", { length: 30 }).notNull(),         // hire | raise | adjustment | correction
  createdBy: varchar("created_by", { length: 255 }).notNull(), // Clerk user id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_salary_employee").on(t.employeeId),
  index("idx_salary_employee_effective").on(t.employeeId, t.effectiveDate),
]);

export const fxRates = pgTable("fx_rates", {
  currency: varchar("currency", { length: 3 }).primaryKey(),
  rateToUsd: numeric("rate_to_usd", { precision: 12, scale: 6 }).notNull(),
  asOfDate: date("as_of_date").notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorClerkUserId: varchar("actor_clerk_user_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),         // create | update | delete
  entityType: varchar("entity_type", { length: 30 }).notNull(),// employee | salary_record
  entityId: uuid("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_audit_entity").on(t.entityType, t.entityId),
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

## 4. API surface

All routes under `/api`, zod-validated body/query/params, all list
endpoints paginated (`limit`/`cursor`), errors in the shared `{ error: {
message, statusCode } }` shape.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /employees | any | Paginated, filterable (country, department, status, search) list |
| GET | /employees/:id | any | Profile + salary history |
| POST | /employees | hr_admin | Create employee (+ initial salary record) |
| PUT | /employees/:id | hr_admin | Update profile fields |
| DELETE | /employees/:id | hr_admin | Soft-delete (status → terminated) |
| POST | /employees/:id/salary | hr_admin | Append a new salary record |
| POST | /employees/import | hr_admin | CSV bulk upload, chunked transactional upsert, per-row error report |
| GET | /employees/export | any | CSV export of current filtered view |
| GET | /analytics/summary | any | Headcount/avg/median/total-cost-USD, sliced by country/department/level |
| GET | /audit-log | any | Paginated, filterable by entity |

CSV import: parsed in-memory (bounded size — a few thousand rows, not the
5k-RPS streaming scenario from the earlier hackathon context), validated
row-by-row with zod, upserted in transactional batches of ~500 keyed on
`employee_number`, response reports `{ created, updated, failed: [{ row,
error }] }`.

## 5. Auth

Clerk, invite-only (no public sign-up — this is an internal tool). Role
lives in `publicMetadata.role`, one of `hr_admin` | `hr_viewer`; unset
defaults to `hr_viewer` (safe default — never silently admin). Extends the
existing `requireAuth` middleware in `auth.middleware.ts` with a
`requireRole("hr_admin")` middleware applied to every mutating route; read
routes need only `requireAuth`.

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
- Sign-in — Clerk's hosted `<SignIn />`.
- Dashboard — summary cards (headcount, avg/median salary, total cost)
  + breakdown charts by country/department, backed by `/analytics/summary`.
- Employees — filterable/searchable/paginated table (shadcn `Table` +
  `DataTable` pattern), import/export buttons (admin-only for import).
- Employee detail — profile + salary-history timeline; "add salary record"
  form visible only to `hr_admin`.
- Audit log — paginated table of changes.

`hr_viewer` role hides every mutating control (buttons, forms) client-side
*and* the API rejects the write server-side regardless — client-side hiding
is UX, not the security boundary.

## 7. Seeding

`hono-worker/scripts/seed.ts`, run with `tsx` against `DATABASE_URL`
directly (same pattern `drizzle-kit` already uses, bypassing Hyperdrive —
migrations/seeding are a deploy-time concern, not a per-request one).
Generates 10,000 employees spread across ~8 countries with
country-appropriate currency and realistic salary bands, plus 1–3 historical
`salary_records` per employee (so the history/analytics features have real
data to exercise), and seeds `fx_rates` with a fixed snapshot.

## 8. Testing

Vitest, fast and deterministic — no network calls, no LLM.

- **Backend unit tests:** currency normalization math, CSV row validation,
  the "current salary" query builder, analytics aggregation logic.
- **Backend route tests:** hit the Hono app against a local test database
  (pglite or a disposable Postgres), covering auth gating (admin vs viewer),
  validation errors, soft-delete behavior, transactional audit-log writes.
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
