import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { compareTotalLandedCost } from "../controllers/tlc.controller.js";

export const tlcRoutes = new Hono<AppBindings>();

// Read-only, no AI, no cost - no rate limit needed (api-security.md rule 1).
tlcRoutes.get("/tlc/compare", requireAuth, resolveOrg, compareTotalLandedCost);
