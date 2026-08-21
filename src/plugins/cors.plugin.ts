import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";

async function corsPlugin(app: FastifyInstance): Promise<void> {
  // Hackathon default: open in dev, locked down in prod until an allowed
  // origins list is wired in (add ALLOWED_ORIGINS to env schema when known).
  await app.register(cors, {
    origin: app.config.NODE_ENV === "production" ? false : true,
    credentials: true,
  });
}

export default fp(corsPlugin, { name: "cors" });
