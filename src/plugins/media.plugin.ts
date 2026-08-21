import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createUnsplashClient, type UnsplashClient } from "../services/media/unsplash.service.js";

declare module "fastify" {
  interface FastifyInstance {
    unsplash: UnsplashClient;
  }
}

async function mediaPlugin(app: FastifyInstance): Promise<void> {
  app.decorate("unsplash", createUnsplashClient(app.config.UNSPLASH_ACCESS_KEY));
}

export default fp(mediaPlugin, { name: "media-clients" });
