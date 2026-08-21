import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool;
    db: NodePgDatabase;
  }
}

async function postgresPlugin(app: FastifyInstance): Promise<void> {
  // Hackathon-scale traditional server assumption: moderate concurrency,
  // no measured ops/sec yet. maxPoolSize/minPoolSize sized conservatively;
  // raise maxPoolSize if wait-queue latency shows pool exhaustion.
  const pool = new Pool({
    connectionString: app.config.DATABASE_URL,
    max: 20,
    min: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    app.log.error({ err }, "postgres pool error");
  });

  await pool.query("SELECT 1");
  app.log.info("postgres connected");

  const db = drizzle(pool);

  app.decorate("pg", pool);
  app.decorate("db", db);

  app.addHook("onClose", async () => {
    await pool.end();
    app.log.info("postgres pool closed");
  });
}

export default fp(postgresPlugin, { name: "postgres" });
