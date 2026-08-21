import type { FastifyInstance } from "fastify";
import fastifyEnv from "@fastify/env";

export interface EnvConfig {
  PORT: string;
  HOST: string;
  NODE_ENV: "development" | "production" | "test";
  MONGODB_URI: string;
  DATABASE_URL: string;
  OPENROUTER_API_KEY: string;
  UNSPLASH_ACCESS_KEY: string;
  PARALLEL_API_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  QSTASH_TOKEN: string;
}

declare module "fastify" {
  interface FastifyInstance {
    config: EnvConfig;
  }
}

// Nothing is `required` here on purpose: this app should boot and serve
// /health even with zero real credentials configured. Each integration
// (postgres, mongo, clerk) checks its own var at plugin-registration time
// and skips connecting rather than crashing the whole process when it's
// blank. Fill in real values in Vercel's dashboard / .env as they become
// available - no code change needed when you do.
const schema = {
  type: "object",
  properties: {
    // Kept as a string, not "number": env vars are always strings, and an
    // empty/malformed value from a dashboard (Vercel doesn't even use PORT
    // for serverless functions) would otherwise fail AJV coercion and crash
    // the whole app before it starts. Parsed to a number only where it's
    // actually used (server.ts's local app.listen()).
    PORT: { type: "string", default: "3000" },
    HOST: { type: "string", default: "0.0.0.0" },
    NODE_ENV: {
      type: "string",
      enum: ["development", "production", "test"],
      default: "development",
    },
    MONGODB_URI: { type: "string", default: "" },
    DATABASE_URL: { type: "string", default: "" },
    OPENROUTER_API_KEY: { type: "string", default: "" },
    UNSPLASH_ACCESS_KEY: { type: "string", default: "" },
    PARALLEL_API_KEY: { type: "string", default: "" },
    CLERK_SECRET_KEY: { type: "string", default: "" },
    CLERK_PUBLISHABLE_KEY: { type: "string", default: "" },
    // Cost/perf: Upstash's REST-based Redis and QStash are the serverless-
    // correct choices here, not a traditional TCP redis/queue - Vercel
    // functions are short-lived, so a persistent connection pool doesn't
    // survive between invocations the way it would on a long-running server.
    UPSTASH_REDIS_REST_URL: { type: "string", default: "" },
    UPSTASH_REDIS_REST_TOKEN: { type: "string", default: "" },
    QSTASH_TOKEN: { type: "string", default: "" },
  },
} as const;

export async function loadEnv(app: FastifyInstance): Promise<void> {
  await app.register(fastifyEnv, {
    schema,
    dotenv: true,
    confKey: "config",
  });
}
