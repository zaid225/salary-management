import { z } from "zod/v4";

// A pay period is currently identified by its bounds - no separate
// "payroll_run" table exists yet (out of scope for this scaffold pass), so
// the caller states the window it wants audited.
export const StartPreflightAuditBody = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
});

export const ReviewProposalBody = z.object({
  decision: z.enum(["approved", "rejected"]),
});

export const CreatePayrollRunBody = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
  // Every active employee in this run is computed under the same
  // jurisdiction for this scaffold pass - a real system would derive it
  // per-employee from their country/state, once more jurisdictions exist.
  jurisdiction: z.enum(["US-CA", "IN", "UK"]),
});

export const RequestEwaBody = z.object({
  employeeId: z.guid(),
  requestedMinor: z.number().int().positive(),
  // The pay period this advance is measured against - same shape a payroll
  // run uses, so the accrual calc has a defined window to pro-rate within.
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
});

export const ReviewEwaRequestBody = z.object({
  decision: z.enum(["approved", "rejected"]),
});

const PunchIn = z.object({
  employeeId: z.guid(),
  type: z.enum(["clock_in", "clock_out"]),
  occurredAt: z.iso.datetime({ offset: true }),
  // That system's own id for this punch - what makes replay idempotent
  // (unique on organizationId+source+externalId).
  externalId: z.string().min(1).max(255),
});

export const HrisWebhookBody = z.object({
  source: z.string().min(1).max(50),
  punches: z.array(PunchIn).min(1).max(500), // bounded batch, not unbounded (database-indexing.md rule 2)
});

// null upToAnnualMinor means "and above" (the open-ended top bracket) - JSON
// has no Infinity literal, so this is the wire representation; the
// controller maps it to the engine's Infinity before running the diff.
const TaxBracketIn = z.object({
  upToAnnualMinor: z.number().positive().nullable(),
  rate: z.number().min(0).max(1),
});

// Exactly one of legalText (AI extracts brackets from free text, gated
// behind Rule #4's schema validation before it can influence anything) or
// proposedBrackets (skip AI entirely, a human already knows the exact
// numbers) - never both, never neither.
export const ProposeTaxRuleDiffBody = z
  .object({
    jurisdiction: z.enum(["US-CA", "IN", "UK"]),
    legalText: z.string().min(1).max(8000).optional(),
    proposedBrackets: z.array(TaxBracketIn).min(1).max(20).optional(),
  })
  .refine((v) => Boolean(v.legalText) !== Boolean(v.proposedBrackets), {
    message: "Provide exactly one of legalText or proposedBrackets",
  });
