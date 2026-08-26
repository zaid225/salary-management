import type { Context } from "hono";
import { z } from "zod/v4";
import type { AppBindings } from "../lib/context.js";
import { getRedis } from "../models/redis.js";

// Reference handler - Hono mirror of fastify-api/src/routes/example.routes.ts.
// Copy this shape for real controllers (validation.md rule 5).
export const EchoBody = z.object({
  message: z.string().min(1),
});

export async function postEcho(
  c: Context<AppBindings, string, { in: { json: z.infer<typeof EchoBody> }; out: { json: z.infer<typeof EchoBody> } }>,
): Promise<Response> {
  const { message } = c.req.valid("json");
  const redis = getRedis(c.env);

  // Cache-or-degrade (scaling-resilience.md rule 5): a Redis error (bad
  // token scope, network blip) must never fail the request - the cache is
  // an optimization, not a dependency.
  let cached: string | null = null;
  if (redis) {
    try {
      cached = await redis.get<string>(`echo:${message}`);
      if (!cached) await redis.set(`echo:${message}`, message, { ex: 60 });
    } catch (err) {
      console.error(
        JSON.stringify({ level: "warn", msg: "redis cache skipped", err: String(err) }),
      );
    }
  }

  return c.json({
    echoed: message,
    cacheHit: Boolean(cached),
    redisConfigured: redis !== null,
  });
}
