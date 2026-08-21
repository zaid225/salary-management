import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.routes.js";
import { authRoutes } from "./auth.routes.js";
import { exampleRoutes } from "./example.routes.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({
    status: "ok",
    message: "Swades Hackathon Backend is running",
    timestamp: new Date().toISOString(),
  }));

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(exampleRoutes, { prefix: "/examples" });
}
