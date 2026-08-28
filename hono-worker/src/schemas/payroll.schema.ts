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
