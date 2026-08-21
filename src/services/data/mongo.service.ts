import type { FastifyInstance } from "fastify";

export async function mongoHealthcheck(
  app: FastifyInstance,
): Promise<{ ok: boolean; configured: boolean; latencyMs: number; error?: string }> {
  const start = performance.now();

  if (!app.mongo) {
    return { ok: false, configured: false, latencyMs: 0, error: "MONGODB_URI not set" };
  }

  try {
    const state = app.mongo.connection.readyState;
    if (state !== 1) throw new Error(`connection state=${state}`);
    await app.mongo.connection.db?.admin().ping();
    return { ok: true, configured: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}
