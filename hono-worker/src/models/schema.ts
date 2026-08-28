import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
  uniqueIndex,
  index,
  date,
  numeric,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

// --- Salary-management domain, every row org-scoped (design spec §3) ---

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    employeeNumber: varchar("employee_number", { length: 32 }).notNull(),
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    country: varchar("country", { length: 2 }).notNull(), // ISO-3166-1 alpha-2
    department: varchar("department", { length: 100 }).notNull(),
    jobTitle: varchar("job_title", { length: 150 }).notNull(),
    level: varchar("level", { length: 20 }).notNull(),
    employmentStatus: varchar("employment_status", { length: 20 }).notNull().default("active"), // active | terminated
    hireDate: date("hire_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_employees_org_employee_number").on(t.organizationId, t.employeeNumber),
    index("idx_employees_org_country").on(t.organizationId, t.country),
    index("idx_employees_org_department").on(t.organizationId, t.department),
    index("idx_employees_org_status").on(t.organizationId, t.employmentStatus),
  ],
);

// Append-only: a raise inserts a new row, it never updates the old one, so
// "current salary" is always the latest effective_date per employee.
export const salaryRecords = pgTable(
  "salary_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(), // ISO-4217
    effectiveDate: date("effective_date").notNull(),
    reason: varchar("reason", { length: 30 }).notNull(), // hire | raise | adjustment | correction
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_salary_org_employee").on(t.organizationId, t.employeeId),
    index("idx_salary_org_employee_effective").on(t.organizationId, t.employeeId, t.effectiveDate),
  ],
);

// Global reference data, deliberately not org-scoped.
export const fxRates = pgTable("fx_rates", {
  currency: varchar("currency", { length: 3 }).primaryKey(),
  rateToUsd: numeric("rate_to_usd", { precision: 12, scale: 6 }).notNull(),
  asOfDate: date("as_of_date").notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    actorClerkUserId: varchar("actor_clerk_user_id", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(), // create | update | delete
    entityType: varchar("entity_type", { length: 30 }).notNull(), // employee | salary_record
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_audit_org_entity").on(t.organizationId, t.entityType, t.entityId)],
);

// --- Background jobs -------------------------------------------------
// Long-running work (bulk delete over thousands of rows) cannot finish
// inside one Worker request, and a browser tab is not a durable place to
// keep progress. The row is the source of truth: closing the tab pauses
// nothing that has already committed, and reopening shows exact progress.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    type: varchar("type", { length: 40 }).notNull(), // bulk_delete_employees
    status: varchar("status", { length: 20 }).notNull().default("queued"), // queued | running | succeeded | failed | cancelled
    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // Whatever the runner needs to pick up where it left off - for a bulk
    // delete, the filter plus the last id already handled.
    params: jsonb("params"),
    cursor: varchar("cursor", { length: 64 }),
    error: text("error"),
    // Lets an unauthenticated runner (a queue callback) prove it was the one
    // asked to run this job, without a user session.
    runToken: varchar("run_token", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_jobs_org_created").on(t.organizationId, t.createdAt),
    index("idx_jobs_org_status").on(t.organizationId, t.status),
  ],
);

export const jobLogs = pgTable(
  "job_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    level: varchar("level", { length: 10 }).notNull(), // info | warn | error
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_job_logs_job").on(t.jobId, t.createdAt)],
);

// --- Payroll/treasury domain, kept in its own file (schema.payroll.ts) ---
export * from "./schema.payroll.js";
