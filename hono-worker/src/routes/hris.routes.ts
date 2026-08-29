import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { validateJson } from "../lib/validate.js";
import { HrisWebhookBody } from "../schemas/payroll.schema.js";
import { ingestHrisWebhook, getAttendance } from "../controllers/hris.controller.js";

export const hrisRoutes = new Hono<AppBindings>();

// Public ingestion endpoint - shared-secret gated inside the handler itself,
// not Clerk auth (api-security.md rule 2: an external HRIS system has no
// Clerk session to present).
hrisRoutes.post("/hris/webhook/:orgId", validateJson(HrisWebhookBody), ingestHrisWebhook);

hrisRoutes.get("/hris/attendance/:employeeId", requireAuth, resolveOrg, getAttendance);
