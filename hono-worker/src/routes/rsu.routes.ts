import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg } from "../controllers/auth.middleware.js";
import { validateJson } from "../lib/validate.js";
import { VestingScheduleBody, VestCalculatorBody } from "../schemas/payroll.schema.js";
import { getVestingSchedule, getVestCalculator } from "../controllers/rsu.controller.js";

export const rsuRoutes = new Hono<AppBindings>();

// Both routes are pure computation - no DB read/write, no AI, no cost - but
// still auth-gated for consistency with every other route in this app.
rsuRoutes.post("/rsu/vesting-schedule", requireAuth, resolveOrg, validateJson(VestingScheduleBody), getVestingSchedule);
rsuRoutes.post("/rsu/vest-calculator", requireAuth, resolveOrg, validateJson(VestCalculatorBody), getVestCalculator);
