import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  bigserial,
  bigint,
} from "drizzle-orm/pg-core";
import { organizations, employees, jobs } from "./schema.js";

// --- Payroll/treasury domain: event-sourced ledger + PII tokenization ---
// Kept in its own file: a distinct product surface from salary management,
// but reuses the same organizations table and the same jobs/job_logs
// machinery for anything long-running (see jobs.ts).

// Append-only. No route ever UPDATEs or DELETEs a row here - corrections
// are new events with eventType 'reversal', referencing the event they
// reverse. This is what makes the ledger auditable: nothing is ever lost,
// only superseded by a later event.
export const ledgerEvents = pgTable(
  "ledger_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sequence: bigserial("sequence", { mode: "bigint" }).notNull(), // total order per org
    eventType: varchar("event_type", { length: 50 }).notNull(), // clock_in | tax_change | paycheck_issued | ewa_advance | reversal
    entityType: varchar("entity_type", { length: 30 }).notNull(), // employee | payroll_run | ewa_request
    entityId: uuid("entity_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }), // integer cents - never a float. Null for non-monetary events.
    currency: varchar("currency", { length: 3 }),
    payload: jsonb("payload").notNull(), // full event detail, schema-versioned by eventType
    reversesEventId: uuid("reverses_event_id"), // set only on a reversal event
    actorClerkUserId: varchar("actor_clerk_user_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ledger_org_seq").on(t.organizationId, t.sequence),
    index("idx_ledger_org_entity").on(t.organizationId, t.entityType, t.entityId),
    // An event can be reversed at most once - a second reversal attempt is a
    // unique-violation the caller must handle, not a silent double-reversal.
    uniqueIndex("uq_ledger_reversal").on(t.reversesEventId),
  ],
);

// Materialized *read* balance, rebuildable at any time by replaying
// ledgerEvents in sequence order - never the write target itself.
// Double-entry: every ledgerEvents row that moves money writes exactly two
// of these (debit + credit), whose deltaMinor values sum to zero.
export const ledgerBalances = pgTable(
  "ledger_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    accountType: varchar("account_type", { length: 30 }).notNull(), // employer_cash | employee_gross | tax_payable | ewa_liability
    accountId: uuid("account_id").notNull(), // employee id, or organization id for employer-level accounts
    eventId: uuid("event_id")
      .notNull()
      .references(() => ledgerEvents.id),
    deltaMinor: bigint("delta_minor", { mode: "number" }).notNull(), // signed integer cents
    currency: varchar("currency", { length: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_balance_org_account").on(t.organizationId, t.accountType, t.accountId)],
);

// PII never reaches an LLM raw (Rule #5). A token is a stable opaque id; the
// mapping lives only here, and no LLM-calling code path ever queries this
// table - it reads pre-tokenized rows that were substituted upstream.
export const piiTokens = pgTable(
  "pii_tokens",
  {
    token: uuid("token").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldType: varchar("field_type", { length: 20 }).notNull(), // ssn | bank_account | full_name
    // Encrypted at the application layer before insert (AES-GCM via a
    // Workers-compatible crypto lib, e.g. the native SubtleCrypto API) -
    // this column holds ciphertext, never plaintext.
    ciphertext: text("ciphertext").notNull(),
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_pii_entity").on(t.organizationId, t.entityType, t.entityId)],
);

// One row per AI-proposed change (anomaly finding, tax-rule diff, RSU
// recommendation) - the human-in-the-loop gate (Rule #4). Nothing here ever
// auto-applies to ledgerEvents; approving one is a separate, explicit
// mutation that itself writes a ledgerEvents row.
export const aiProposals = pgTable(
  "ai_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    proposalType: varchar("proposal_type", { length: 40 }).notNull(), // preflight_anomaly | tax_diff | rsu_recommendation
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | approved | rejected
    jobId: uuid("job_id").references(() => jobs.id), // the sandbox/audit run that produced this, reusing jobs.ts
    diff: jsonb("diff").notNull(), // deterministic, human-readable before/after
    modelUsed: varchar("model_used", { length: 100 }),
    reviewedBy: varchar("reviewed_by", { length: 255 }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // SHA-256 of (diff + reviewerId + reviewedAt) - the "cryptographic
    // sign-off" the brief requires before a proposal can ever take effect.
    signOffHash: varchar("sign_off_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_proposals_org_status").on(t.organizationId, t.status)],
);

// A payroll run for one org/period, moving through a strict status
// pipeline: draft -> calculated -> posted (or cancelled at any point before
// posted). Only 'posted' ever writes to ledgerEvents/ledgerBalances -
// calculating is free to re-run as many times as needed while still draft.
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    periodStart: text("period_start").notNull(), // YYYY-MM-DD
    periodEnd: text("period_end").notNull(),
    // Fixed at creation, not passed per-call - every line in a run is
    // computed under one jurisdiction for this scaffold pass.
    jurisdiction: varchar("jurisdiction", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft | calculated | posted | cancelled
    totalGrossMinor: bigint("total_gross_minor", { mode: "number" }).notNull().default(0),
    totalNetMinor: bigint("total_net_minor", { mode: "number" }).notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [index("idx_payroll_runs_org_status").on(t.organizationId, t.status)],
);

// One row per employee per run. Recalculating a still-draft run replaces
// these rows entirely (delete + reinsert in one transaction) rather than
// updating in place, so a run's lines are always a clean, current snapshot
// of the last calculation.
export const payrollRunLines = pgTable(
  "payroll_run_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollRunId: uuid("payroll_run_id")
      .notNull()
      .references(() => payrollRuns.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    jurisdiction: varchar("jurisdiction", { length: 20 }).notNull(),
    supported: text("supported").notNull(), // "true" | "false" - stored as text since Drizzle boolean would need a migration column type most other tables here don't use
    grossMinor: bigint("gross_minor", { mode: "number" }),
    netMinor: bigint("net_minor", { mode: "number" }),
    currency: varchar("currency", { length: 3 }),
    deductions: jsonb("deductions"), // DeductionLine[] from payroll-engine.ts
    unsupportedReason: text("unsupported_reason"),
  },
  (t) => [index("idx_payroll_lines_run").on(t.payrollRunId)],
);
