import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { rateLimitByOrg } from "../controllers/rate-limit.middleware.js";
import { validateJson } from "../lib/validate.js";
import { ProposeTaxRuleDiffBody } from "../schemas/payroll.schema.js";
import { proposeTaxRuleDiff } from "../controllers/tax-rules.controller.js";

export const taxRulesRoutes = new Hono<AppBindings>();

taxRulesRoutes.post(
  "/tax-rules/propose-diff",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  // The legalText path is a real LLM call - same "costs money" justification
  // as the pre-flight auditor (api-security.md rule 1). The proposedBrackets
  // path costs nothing, but the limit is cheap insurance either way.
  rateLimitByOrg(10, 3600),
  validateJson(ProposeTaxRuleDiffBody),
  proposeTaxRuleDiff,
);
