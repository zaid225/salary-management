import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";

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

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    const app = await getApp();
    app.server.emit("request", req, res);
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
