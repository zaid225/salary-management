import type { Context } from "hono";
import type { AppBindings } from "../lib/context.js";

export function getHealth(c: Context<AppBindings>): Response {
  const env = c.env;
  return c.json({
    status: "ok",
    runtime: "cloudflare-worker",
    // `configured: false` for an intentionally-unset integration is
    // correct, not an error - single-database-selection.md rule 5. Just
    // checks the binding exists - doesn't open a connection to report health.
    postgres: { configured: Boolean(env.HYPERDRIVE) },
    mongo: {
      configured: Boolean(
        env.MONGODB_DATA_API_URL && env.MONGODB_DATA_API_KEY && env.MONGODB_DATA_SOURCE,
      ),
    },
    redis: { configured: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) },
    auth: { configured: Boolean(env.CLERK_SECRET_KEY) },
  });
}
