import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pgHealthcheck } from "../services/data/postgres.service.js";
import { mongoHealthcheck } from "../services/data/mongo.service.js";

export async function getHealth(
  app: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const [postgres, mongo] = await Promise.all([
    pgHealthcheck(app),
    mongoHealthcheck(app),
  ]);

  const ok = postgres.ok && mongo.ok;

  reply.code(ok ? 200 : 503);
  return {
    status: ok ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: { postgres, mongo },
  };
}
