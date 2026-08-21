import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createOpenRouterClient, type OpenRouterClient } from "../services/ai/openrouter.service.js";
import { createParallelClient, type ParallelClient } from "../services/ai/parallel.service.js";

declare module "fastify" {
  interface FastifyInstance {
    openrouter: OpenRouterClient;
    parallel: ParallelClient;
  }
}

async function aiPlugin(app: FastifyInstance): Promise<void> {
  app.decorate("openrouter", createOpenRouterClient(app.config.OPENROUTER_API_KEY));
  app.decorate("parallel", createParallelClient(app.config.PARALLEL_API_KEY));
}

export default fp(aiPlugin, { name: "ai-clients" });
