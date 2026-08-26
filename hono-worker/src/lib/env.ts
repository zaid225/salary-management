import { z } from "zod/v4";

// Cloudflare Workers: bindings/vars arrive per-request via `c.env`, not
// `process.env` - no module-level parse like the Fastify side's
// `@fastify/env`. Call `parseEnv(c.env)` inside a middleware on first use.
// Nothing is `required` - same rationale as src/config/env.ts: the worker
// must boot and serve /health with zero integrations configured.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().default(""),
  MONGODB_DATA_API_URL: z.string().default(""),
  MONGODB_DATA_API_KEY: z.string().default(""),
  MONGODB_DATA_SOURCE: z.string().default(""),
  CLERK_SECRET_KEY: z.string().default(""),
  CLERK_PUBLISHABLE_KEY: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),
  UNSPLASH_ACCESS_KEY: z.string().default(""),
  PARALLEL_API_KEY: z.string().default(""),
  UPSTASH_REDIS_REST_URL: z.string().default(""),
  UPSTASH_REDIS_REST_TOKEN: z.string().default(""),
  QSTASH_TOKEN: z.string().default(""),
  ALLOWED_ORIGIN: z.string().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: unknown): Env {
  return EnvSchema.parse(raw);
}
