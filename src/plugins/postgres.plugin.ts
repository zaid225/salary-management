import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool | null;
    db: NodePgDatabase | null;
  }
}

async function postgresPlugin(app: FastifyInstance): Promise<void> {
  if (!app.config.DATABASE_URL) {
    app.log.warn("DATABASE_URL not set - skipping Postgres connection");
    app.decorate("pg", null);
    app.decorate("db", null);
    return;
  }

  // Deploy target is Vercel serverless (each function instance gets its own
  // pool, and the module is cached across warm invocations - see api/index.ts).
  // Sized per Vercel's own connection-pooling guidance: small maxPoolSize,
  // minPoolSize 0 so idle instances don't hold connections open. Same values
  // work fine for local `npm run dev` at hackathon traffic levels; raise
  // maxPoolSize only if you see wait-queue latency under real load.
  const pool = new Pool({
    connectionString: app.config.DATABASE_URL,
    max: 5,
    min: 0,
    idleTimeoutMillis: 10_000,
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
