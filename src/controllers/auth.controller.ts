import type { FastifyRequest, FastifyReply } from "fastify";

export async function getMe(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth) return reply.unauthorized("Not authenticated");
  return { userId: request.auth.userId, sessionId: request.auth.sessionId };
}
