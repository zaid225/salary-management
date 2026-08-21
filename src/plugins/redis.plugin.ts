import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Redis } from "@upstash/redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis | null;
  }
}

async function redisPlugin(app: FastifyInstance): Promise<void> {
  if (!app.config.UPSTASH_REDIS_REST_URL || !app.config.UPSTASH_REDIS_REST_TOKEN) {
    app.log.warn("UPSTASH_REDIS_REST_URL/TOKEN not set - skipping Redis cache");
    app.decorate("redis", null);
    return;
  }

  // Upstash's client is REST/HTTP based (fetch under the hood), not a
  // persistent TCP connection - the right shape for serverless, where a
  // pooled connection wouldn't survive between cold invocations anyway.
  const redis = new Redis({
    url: app.config.UPSTASH_REDIS_REST_URL,
    token: app.config.UPSTASH_REDIS_REST_TOKEN,
  });

  app.decorate("redis", redis);
  app.log.info("upstash redis configured");
}

export default fp(redisPlugin, { name: "redis" });
