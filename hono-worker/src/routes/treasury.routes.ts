import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { getTreasuryForecast } from "../controllers/treasury.controller.js";

export const treasuryRoutes = new Hono<AppBindings>();

// Read-only, no AI, no cost - no rate limit needed (api-security.md rule 1
// only requires one for money-costing or publicly-writable routes; this is
// neither).
treasuryRoutes.get("/treasury/forecast", requireAuth, resolveOrg, getTreasuryForecast);
