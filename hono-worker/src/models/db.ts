import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { CloudflareBindings } from "../lib/context.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

// Cloudflare's own guidance: create a new client per request, not a
// module-level singleton - Hyperdrive already pools the real connection on
// its side, so client creation here is cheap. Never a raw `pg.Pool` held
// across requests (single-database-selection.md rule 3's Workers caveat).
// `sql.end()` is optional with Hyperdrive but still called from the route
// via `ctx.waitUntil` so a slow-closing socket doesn't hold up the response.
export function getDb(env: CloudflareBindings): { db: Db; close: () => Promise<void> } | null {
  if (!env.HYPERDRIVE) return null;

  const client = postgres(env.HYPERDRIVE.connectionString, { max: 5 });
  const db = drizzle(client, { schema });

  return { db, close: () => client.end() };
}

// MongoDB Atlas Data API is HTTP-based - the correct shape for Workers
// (no persistent connection needed). Null-checked at every call site per
// single-database-selection.md rule 3's Hono variant.
export async function mongoFind(
  env: CloudflareBindings,
  collection: string,
  filter: Record<string, unknown> = {},
  limit = 50,
): Promise<unknown[] | null> {
  if (!env.MONGODB_DATA_API_URL || !env.MONGODB_DATA_API_KEY || !env.MONGODB_DATA_SOURCE) {
    return null;
  }
  const res = await fetch(`${env.MONGODB_DATA_API_URL}/action/find`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": env.MONGODB_DATA_API_KEY,
    },
    body: JSON.stringify({
      dataSource: env.MONGODB_DATA_SOURCE,
      database: "hackdb",
      collection,
      filter,
      limit, // database-indexing.md rule 2: never unbounded
    }),
    signal: AbortSignal.timeout(15_000), // scaling-resilience.md rule 1
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { documents: unknown[] };
  return json.documents;
}
