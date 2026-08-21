import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import mongoose from "mongoose";

declare module "fastify" {
  interface FastifyInstance {
    mongo: typeof mongoose | null;
  }
}

async function mongoPlugin(app: FastifyInstance): Promise<void> {
  if (!app.config.MONGODB_URI) {
    app.log.warn("MONGODB_URI not set - skipping MongoDB connection");
    app.decorate("mongo", null);
    return;
  }

  // Same serverless assumption as postgres.plugin.ts: Vercel functions, one
  // pool per warm instance, minPoolSize 0 to release connections when idle.
  mongoose.set("strictQuery", true);

  await mongoose.connect(app.config.MONGODB_URI, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 10_000,
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
  });

  mongoose.connection.on("error", (err) => {
    app.log.error({ err }, "mongodb connection error");
  });

  app.log.info("mongodb connected");
  app.decorate("mongo", mongoose);

  app.addHook("onClose", async () => {
    await mongoose.disconnect();
    app.log.info("mongodb disconnected");
  });
}

export default fp(mongoPlugin, { name: "mongo" });
