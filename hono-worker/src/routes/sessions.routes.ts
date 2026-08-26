import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth } from "../controllers/auth.middleware.js";
import {
  CreateSessionBody,
  ListSessionsQuery,
  createSession,
  getSession,
  listSessions,
} from "../controllers/sessions.controller.js";

// Same normalized-4xx pattern as example.routes.ts - zValidator's default
// failure response bypasses onError otherwise (error-handling-logging.md rule 1).
function normalizeError(result: { success: boolean; error?: { issues: { message: string }[] } }, c: import("hono").Context) {
  if (!result.success) {
    return c.json(
      { error: { message: result.error?.issues[0]?.message ?? "Invalid request", statusCode: 400 } },
      400,
    );
  }
}

export const sessionsRoutes = new Hono<AppBindings>();

sessionsRoutes.get("/sessions", zValidator("query", ListSessionsQuery, normalizeError), listSessions);
sessionsRoutes.get("/sessions/:id", getSession);
// POST creates a resource - auth-gated per api-security.md rule 2.
sessionsRoutes.post(
  "/sessions",
  requireAuth,
  zValidator("json", CreateSessionBody, normalizeError),
  createSession,
);
