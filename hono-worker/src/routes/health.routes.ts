import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { getHealth } from "../controllers/health.controller.js";

export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get("/health", getHealth);
