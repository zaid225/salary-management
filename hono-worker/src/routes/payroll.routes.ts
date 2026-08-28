import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { rateLimitByOrg } from "../controllers/rate-limit.middleware.js";
import { validateJson } from "../lib/validate.js";
import { StartPreflightAuditBody, ReviewProposalBody } from "../schemas/payroll.schema.js";
import { startPreflightAudit, reviewProposal, listProposals, listLedgerEvents } from "../controllers/payroll-audit.controller.js";

export const payrollRoutes = new Hono<AppBindings>();

payrollRoutes.post(
  "/payroll/preflight-audit",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  // Each call is a real LLM request - same "costs money" justification as
  // CSV import's limit (api-security.md rule 1).
  rateLimitByOrg(10, 3600),
  validateJson(StartPreflightAuditBody),
  startPreflightAudit,
);

payrollRoutes.get("/ledger-events", requireAuth, resolveOrg, listLedgerEvents);
payrollRoutes.get("/ai-proposals", requireAuth, resolveOrg, listProposals);
payrollRoutes.post(
  "/ai-proposals/:proposalId/review",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(ReviewProposalBody),
  reviewProposal,
);
