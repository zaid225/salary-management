import { Redis } from "@upstash/redis";
import type { Env } from "../lib/env.js";

// Lazy singleton - Hono/edge equivalent of the Fastify redis.plugin.ts
// decorator (env-vars.md rule 4). Returns null, never throws, when unset.
let cached: Redis | null | undefined;

export function getRedis(env: Env): Redis | null {
  if (cached !== undefined) return cached;
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    cached = null;
    return cached;
  }
  cached = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return cached;
}
