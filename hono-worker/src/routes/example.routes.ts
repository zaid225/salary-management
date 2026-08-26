import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { rateLimitByIp } from "../controllers/rate-limit.middleware.js";
import { EchoBody, postEcho } from "../controllers/example.controller.js";

export const exampleRoutes = new Hono<AppBindings>();

// zValidator's default failure response bypasses onError - normalize it to
// the shared { error: { message, statusCode } } shape here so every 4xx
// looks the same regardless of which layer rejected it
// (error-handling-logging.md rule 1).
const validateEchoBody = zValidator("json", EchoBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

exampleRoutes.post("/echo", rateLimitByIp(100, 60), validateEchoBody, postEcho);
