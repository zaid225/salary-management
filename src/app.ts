import type { IncomingMessage, ServerResponse } from "node:http";
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
      // pino-pretty spawns a worker thread, which routinely fails under
      // Vercel's serverless bundling. Key off Vercel's own VERCEL=1 (set
      // automatically on every deployment) instead of trusting NODE_ENV to
      // be set correctly - a wrong NODE_ENV value must never re-enable this.
      transport: process.env.VERCEL ? undefined : { target: "pino-pretty" },
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

// --- Vercel serverless entry -----------------------------------------
//
// Vercel's zero-config Node.js builder requires finding a conventional
// entrypoint file (app.js/server.js) somewhere in the repo - without one,
// the whole build fails with "No entrypoint found" (confirmed the hard
// way). It then invokes whatever it finds directly for the "/" route,
// regardless of vercel.json's rewrites, expecting a default export that's
// a function or an http.Server. Providing that here means "/" works
// correctly instead of crashing with "default export must be a function
// or server" - api/index.ts re-exports this same handler as the primary,
// intended entry (see vercel.json's rewrite), so both behave identically.
//
// Cached across warm invocations of the same serverless instance.
let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = buildServer().then(async (app) => {
      await app.ready();
      return app;
    });
  }
  return appPromise;
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const app = await getApp();
    // emit() is fire-and-forget: it triggers Fastify's async request
    // handling but returns before that handling completes. Without waiting
    // for the response to actually finish, this handler's promise resolves
    // early and Vercel can tear down the function mid-response -
    // FUNCTION_INVOCATION_FAILED for any route not fast enough to win
    // that race.
    await new Promise<void>((resolve, reject) => {
      res.once("finish", resolve);
      res.once("close", resolve);
      res.once("error", reject);
      app.server.emit("request", req, res);
    });
  } catch (err) {
    // Don't cache a permanently-broken promise - next invocation retries.
    appPromise = null;
    console.error("cold start failed", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          message: "Server failed to start",
          detail: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}
