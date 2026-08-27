import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { AuditLogQuery } from "../schemas/audit.schema.js";
import { validateQuery } from "../lib/validate.js";
import { listAuditLog } from "../controllers/audit.controller.js";

export const auditRoutes = new Hono<AppBindings>();

auditRoutes.get("/audit-log", requireAuth, resolveOrg, validateQuery(AuditLogQuery), listAuditLog);
