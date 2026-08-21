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
  const configured = Boolean(app.config.CLERK_SECRET_KEY && app.config.CLERK_PUBLISHABLE_KEY);

  app.decorateRequest("auth", undefined);

  if (!configured) {
    app.log.warn(
      "CLERK_SECRET_KEY/CLERK_PUBLISHABLE_KEY not set - skipping Clerk registration, /auth routes will 501",
    );
    app.decorate(
      "authenticate",
      async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.notImplemented("Auth is not configured on this deployment");
      },
    );
    return;
  }

  await app.register(clerkPlugin, {
    secretKey: app.config.CLERK_SECRET_KEY,
    publishableKey: app.config.CLERK_PUBLISHABLE_KEY,
  });

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
