import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../lib/context.js";

// One shared error shape across the whole API - matches
// fastify-api/src/middlewares/error-handler.ts's contract exactly, so the
// frontend sees one JSON contract regardless of which backend answered.
export function onError(err: Error, c: Context<AppBindings>): Response {
  const statusCode = err instanceof HTTPException ? err.status : 500;

  console.error(
    JSON.stringify({
      level: "error",
      msg: "request error",
      reqId: c.get("reqId"),
      err: err.message,
      time: Date.now(),
    }),
  );

  return c.json(
    {
      error: {
        message: statusCode >= 500 ? "Internal Server Error" : err.message,
        statusCode,
      },
    },
    statusCode as 400 | 401 | 403 | 404 | 422 | 429 | 500,
  );
}

export function notFound(c: Context<AppBindings>): Response {
  return c.json(
    {
      error: {
        message: `Route ${c.req.method} ${c.req.path} not found`,
        statusCode: 404,
      },
    },
    404,
  );
}
