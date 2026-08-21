import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { clerkPlugin, getAuth } from "@clerk/fastify";

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(clerkPlugin, {
    secretKey: app.config.CLERK_SECRET_KEY,
    publishableKey: app.config.CLERK_PUBLISHABLE_KEY,
  });

  app.decorateRequest("auth", undefined);

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(request);

      if (!auth.userId || !auth.sessionId) {
        return reply.unauthorized("Invalid or missing session token");
      }

      request.auth = { userId: auth.userId, sessionId: auth.sessionId };
    },
  );
}

export default fp(authPlugin, { name: "auth" });
