import type { FastifyInstance } from "fastify";
import { getMe } from "../controllers/auth.controller.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: app.authenticate }, getMe);
}
