import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";

import { loadEnv } from "./config/env.js";
import corsPlugin from "./plugins/cors.plugin.js";
import postgresPlugin from "./plugins/postgres.plugin.js";
import mongoPlugin from "./plugins/mongo.plugin.js";
import authPlugin from "./plugins/auth.plugin.js";
import aiClients from "./plugins/ai.plugin.js";
import mediaClients from "./plugins/media.plugin.js";

import { registerRoutes } from "./routes/index.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty" },
    },
  });

  await loadEnv(app);

  await app.register(sensible);
  await app.register(corsPlugin);
  await app.register(postgresPlugin);
  await app.register(mongoPlugin);
  await app.register(authPlugin);
  await app.register(aiClients);
  await app.register(mediaClients);

  registerErrorHandler(app);

  await registerRoutes(app);

  return app;
}
