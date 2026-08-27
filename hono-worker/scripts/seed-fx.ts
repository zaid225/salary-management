import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/models/schema.js";
import { FX_SNAPSHOT } from "./fx-snapshot.js";

declare const process: { env: Record<string, string | undefined>; exit(code?: number): never };

// fx_rates is global reference data, not tenant data, and every analytics
// figure INNER JOINs it - an empty table silently blanks the whole dashboard.
// This is split out from the full seed so the rates can be (re)loaded on their
// own, without touching organizations or employees.
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL env var required");

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  await db
    .insert(schema.fxRates)
    .values(FX_SNAPSHOT)
    .onConflictDoUpdate({
      target: schema.fxRates.currency,
      set: { rateToUsd: schema.fxRates.rateToUsd, asOfDate: schema.fxRates.asOfDate },
    });

  const rows = await db.select().from(schema.fxRates);
  console.log(`fx_rates loaded: ${rows.map((r) => `${r.currency}=${r.rateToUsd}`).join(" ")}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
