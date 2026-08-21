import type { FastifyInstance } from "fastify";
import fastifyEnv from "@fastify/env";

export interface EnvConfig {
  PORT: number;
  HOST: string;
  NODE_ENV: "development" | "production" | "test";
  MONGODB_URI: string;
  DATABASE_URL: string;
  OPENROUTER_API_KEY: string;
  UNSPLASH_ACCESS_KEY: string;
  PARALLEL_API_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
}

declare module "fastify" {
  interface FastifyInstance {
    config: EnvConfig;
  }
}

const schema = {
  type: "object",
  required: [
    "MONGODB_URI",
    "DATABASE_URL",
    "OPENROUTER_API_KEY",
    "UNSPLASH_ACCESS_KEY",
    "PARALLEL_API_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
  ],
  properties: {
    PORT: { type: "number", default: 3000 },
    HOST: { type: "string", default: "0.0.0.0" },
    NODE_ENV: {
      type: "string",
      enum: ["development", "production", "test"],
      default: "development",
    },
    MONGODB_URI: { type: "string" },
    DATABASE_URL: { type: "string" },
    OPENROUTER_API_KEY: { type: "string" },
    UNSPLASH_ACCESS_KEY: { type: "string" },
    PARALLEL_API_KEY: { type: "string" },
    CLERK_SECRET_KEY: { type: "string" },
    CLERK_PUBLISHABLE_KEY: { type: "string" },
  },
} as const;

export async function loadEnv(app: FastifyInstance): Promise<void> {
  await app.register(fastifyEnv, {
    schema,
    dotenv: true,
    confKey: "config",
  });
}
