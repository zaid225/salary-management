import type { FastifyInstance } from "fastify";
import { getHealth } from "../controllers/health.controller.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", (request, reply) => getHealth(app, request, reply));
}
