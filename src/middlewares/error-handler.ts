import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = error.statusCode ?? 500;

      request.log.error({ err: error }, "request error");

      reply.code(statusCode).send({
        error: {
          message: statusCode >= 500 ? "Internal Server Error" : error.message,
          code: error.code,
          statusCode,
        },
      });
    },
  );

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
      },
    });
  });
}
