import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createQStashQueue, type QStashQueue } from "../services/queue/qstash.service.js";

declare module "fastify" {
  interface FastifyInstance {
    queue: QStashQueue | null;
  }
}

async function queuePlugin(app: FastifyInstance): Promise<void> {
  if (!app.config.QSTASH_TOKEN) {
    app.log.warn("QSTASH_TOKEN not set - skipping QStash queue client");
    app.decorate("queue", null);
    return;
  }

  app.decorate("queue", createQStashQueue(app.config.QSTASH_TOKEN));
  app.log.info("qstash queue configured");
}

export default fp(queuePlugin, { name: "queue" });
