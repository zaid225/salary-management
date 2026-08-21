import type { FastifyInstance } from "fastify";

export async function pgHealthcheck(
  app: FastifyInstance,
): Promise<{ ok: boolean; configured: boolean; latencyMs: number; error?: string }> {
  const start = performance.now();

  if (!app.pg) {
    return { ok: false, configured: false, latencyMs: 0, error: "DATABASE_URL not set" };
  }

  try {
    await app.pg.query("SELECT 1");
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
