import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { validateJson } from "../lib/validate.js";
import { CreatePayrollRunBody } from "../schemas/payroll.schema.js";
import {
  createPayrollRun,
  calculatePayrollRun,
  postPayrollRun,
  getPayrollRun,
  listPayrollRuns,
} from "../controllers/payroll-runs.controller.js";

export const payrollRunsRoutes = new Hono<AppBindings>();

payrollRunsRoutes.get("/payroll-runs", requireAuth, resolveOrg, listPayrollRuns);
payrollRunsRoutes.post(
  "/payroll-runs",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(CreatePayrollRunBody),
  createPayrollRun,
);
payrollRunsRoutes.get("/payroll-runs/:runId", requireAuth, resolveOrg, getPayrollRun);
payrollRunsRoutes.post(
  "/payroll-runs/:runId/calculate",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  calculatePayrollRun,
);
// Posting writes real ledger entries - the single most consequential action
// in this whole scaffold, so it is admin-gated the same as everything else
// that mutates money, with the status-machine guard doing the actual
// enforcement (only 'calculated' -> 'posted' is legal).
payrollRunsRoutes.post(
  "/payroll-runs/:runId/post",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  postPayrollRun,
);
