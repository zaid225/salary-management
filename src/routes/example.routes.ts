import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { jsonToToon } from "../utils/toon.js";

// Reference route showing the zod + TOON + Redis wiring end-to-end. Not
// meant to ship as-is - copy the pattern for real routes tomorrow.
const EchoBody = z.object({
  message: z.string().min(1),
  data: z.array(z.record(z.string(), z.unknown())).optional(),
});

export async function exampleRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/echo",
    { schema: { body: EchoBody } },
    async (request) => {
      // request.body is typed from EchoBody via the zod type provider.
      const { message, data } = request.body;

      // TOON: convert tabular data to its compact form before it'd go into
      // an LLM prompt - not needed for the response itself, shown here only
      // to demonstrate the round-trip.
      const toon = data ? jsonToToon(data) : null;

      // Redis: cache-aside example, no-ops cleanly when not configured.
      const cacheKey = `echo:${message}`;
      const cached = await app.redis?.get<string>(cacheKey);
      if (!cached && app.redis) {
        await app.redis.set(cacheKey, message, { ex: 60 });
      }

      return {
        echoed: message,
        toonPreview: toon,
        cacheHit: Boolean(cached),
        redisConfigured: app.redis !== null,
        queueConfigured: app.queue !== null,
      };
    },
  );
}
