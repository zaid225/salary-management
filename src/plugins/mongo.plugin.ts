import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import mongoose from "mongoose";

declare module "fastify" {
  interface FastifyInstance {
    mongo: typeof mongoose;
  }
}

async function mongoPlugin(app: FastifyInstance): Promise<void> {
  // Same hackathon-scale assumption as postgres.ts: traditional long-running
  // server, moderate concurrency. maxPoolSize kept conservative; raise if
  // connection wait times are observed under load.
  mongoose.set("strictQuery", true);

  await mongoose.connect(app.config.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 2,
    maxIdleTimeMS: 30_000,
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
