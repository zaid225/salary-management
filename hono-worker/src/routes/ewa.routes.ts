import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { validateJson } from "../lib/validate.js";
import { RequestEwaBody, ReviewEwaRequestBody } from "../schemas/payroll.schema.js";
import {
  requestEwaAdvance,
  reviewEwaRequest,
  listEwaRequests,
  getEwaAccrual,
} from "../controllers/ewa.controller.js";

export const ewaRoutes = new Hono<AppBindings>();

ewaRoutes.get("/ewa/accrual/:employeeId", requireAuth, resolveOrg, getEwaAccrual);
ewaRoutes.get("/ewa/requests", requireAuth, resolveOrg, listEwaRequests);
ewaRoutes.post(
  "/ewa/requests",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(RequestEwaBody),
  requestEwaAdvance,
);
// Approving writes real ledger entries (money out) - admin-gated the same
// as posting a payroll run, with the status-machine guard (pending only)
// doing the actual enforcement.
ewaRoutes.post(
  "/ewa/requests/:requestId/review",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(ReviewEwaRequestBody),
  reviewEwaRequest,
);
