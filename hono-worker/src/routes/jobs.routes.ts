import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { validateJson, validateQuery } from "../lib/validate.js";
import { BulkDeleteBody } from "../schemas/job.schema.js";
import { PaginationQuery } from "../schemas/pagination.schema.js";
import {
  advanceJob,
  cancelJob,
  createBulkDeleteJob,
  getJob,
  listOrgJobs,
} from "../controllers/jobs.controller.js";

export const jobsRoutes = new Hono<AppBindings>();

jobsRoutes.post(
  "/employees/bulk-delete",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(BulkDeleteBody),
  createBulkDeleteJob,
);

jobsRoutes.get("/jobs", requireAuth, resolveOrg, validateQuery(PaginationQuery), listOrgJobs);
jobsRoutes.get("/jobs/:jobId", requireAuth, resolveOrg, getJob);
jobsRoutes.post("/jobs/:jobId/cancel", requireAuth, resolveOrg, requireRole("admin"), cancelJob);

// Session-authenticated runner: this is what the browser calls while someone
// is watching a job.
jobsRoutes.post("/jobs/:jobId/advance", requireAuth, resolveOrg, requireRole("admin"), advanceJob);

// Unattended runner. No session and no org resolution - the job's own run
// token is the authority, checked against the row inside the handler, so this
// is not an open write endpoint despite being unauthenticated in the usual
// sense.
jobsRoutes.post("/jobs/:jobId/run", advanceJob);
