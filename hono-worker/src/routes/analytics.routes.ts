import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { getAnalyticsSummary } from "../controllers/analytics.controller.js";

export const analyticsRoutes = new Hono<AppBindings>();

analyticsRoutes.get("/analytics/summary", requireAuth, resolveOrg, getAnalyticsSummary);
