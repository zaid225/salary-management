import { Hono } from "hono";
import type { AppBindings } from "../lib/context.js";
import { handleClerkWebhook } from "../controllers/webhooks.controller.js";

export const webhooksRoutes = new Hono<AppBindings>();

webhooksRoutes.post("/webhooks/clerk", handleClerkWebhook);
