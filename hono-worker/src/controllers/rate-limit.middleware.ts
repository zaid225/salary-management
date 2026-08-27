import { Ratelimit } from "@upstash/ratelimit";
import type { Context, Next } from "hono";
import { getRedis } from "../models/redis.js";
import type { AppBindings } from "../lib/context.js";

// Dual-mode: sliding window smooths cost-bearing routes (OpenRouter,
// Unsplash, Parallel) - api-security.md rule 1. Degrades to a no-op, not a
// crash, when Redis isn't configured (matches redis.plugin.ts's contract).
export function rateLimitByIp(limit: number, windowSeconds: number) {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | void> => {
    const redis = getRedis(c.env);
    if (!redis) {
      await next();
      return;
    }

    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    });

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    // Degrade to no-op on a Redis-side failure (bad token scope, network
    // blip) rather than 500ing every request behind it - rate limiting is
    // a protection, not a hard dependency (scaling-resilience.md rule 5).
    try {
      const { success } = await ratelimit.limit(ip);
      if (!success) {
        return c.json(
          { error: { message: "Too many requests", statusCode: 429 } },
          429,
        );
      }
    } catch (err) {
      console.error(JSON.stringify(rateLimitSkipLog(err)));
    }

    await next();
  };
}

// Same dual-mode/degrade contract as rateLimitByIp, keyed by the resolved
// organization instead of the caller's IP - protects a per-org resource
// (invite spam, CSV import cost) rather than a per-caller one.
export function rateLimitByOrg(limit: number, windowSeconds: number) {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | void> => {
    const redis = getRedis(c.env);
    if (!redis) {
      await next();
      return;
    }

    const orgId = c.get("orgId");
    if (!orgId) {
      await next();
      return;
    }

    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
    });

    try {
      const { success } = await ratelimit.limit(orgId);
      if (!success) {
        return c.json({ error: { message: "Too many requests", statusCode: 429 } }, 429);
      }
    } catch (err) {
      console.error(JSON.stringify(rateLimitSkipLog(err)));
    }

    await next();
  };
}

// @upstash/ratelimit runs its sliding-window algorithm as a Lua script, so
// the credential needs EVAL/EVALSHA. A read-only REST token passes GET and
// fails here with NOPERM - worth naming, because the symptom is otherwise a
// vague "skipped" line and silently unlimited endpoints.
function rateLimitSkipLog(err: unknown): Record<string, string> {
  const text = String(err);
  const base = { level: "warn", msg: "rate limit check skipped", err: text };
  if (text.includes("NOPERM")) {
    return {
      ...base,
      cause: "Upstash credential lacks EVAL permission - this looks like the read-only REST token",
      fix: "Set UPSTASH_REDIS_REST_TOKEN to the full-access token from the Upstash console",
    };
  }
  return base;
}
