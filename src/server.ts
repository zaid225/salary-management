import Fastify from "fastify";
import sensible from "@fastify/sensible";
import closeWithGrace from "close-with-grace";

import { loadEnv } from "./config/env.js";
import corsPlugin from "./plugins/cors.plugin.js";
import postgresPlugin from "./plugins/postgres.plugin.js";
import mongoPlugin from "./plugins/mongo.plugin.js";
import authPlugin from "./plugins/auth.plugin.js";
import aiClients from "./plugins/ai.plugin.js";
import mediaClients from "./plugins/media.plugin.js";

import { registerRoutes } from "./routes/index.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

async function buildServer() {
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

async function start() {
  const app = await buildServer();

  closeWithGrace({ delay: 5000 }, async ({ err }) => {
    if (err) app.log.error({ err }, "closing due to error");
    await app.close();
  });

  try {
    await app.listen({ host: app.config.HOST, port: app.config.PORT });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

start();
