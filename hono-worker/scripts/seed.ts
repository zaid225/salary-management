import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/models/schema.js";
import { generateEmployees } from "./generate-employees.js";

const FX_SNAPSHOT = [
  { currency: "USD", rateToUsd: "1.000000", asOfDate: "2026-01-01" },
  { currency: "GBP", rateToUsd: "1.270000", asOfDate: "2026-01-01" },
  { currency: "EUR", rateToUsd: "1.090000", asOfDate: "2026-01-01" },
  { currency: "INR", rateToUsd: "0.012000", asOfDate: "2026-01-01" },
  { currency: "CAD", rateToUsd: "0.730000", asOfDate: "2026-01-01" },
  { currency: "AUD", rateToUsd: "0.660000", asOfDate: "2026-01-01" },
  { currency: "SGD", rateToUsd: "0.740000", asOfDate: "2026-01-01" },
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function seedOrg(
  db: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
  slug: string,
  employeeCount: number,
  adminClerkUserId: string,
) {
  const rows = await db.insert(schema.organizations).values({ name, slug }).returning();
  const org = rows[0];
  if (!org) throw new Error("organization insert did not return a row");

  await db.insert(schema.memberships).values({
    organizationId: org.id,
    clerkUserId: adminClerkUserId,
    role: "admin",
    status: "active",
  });

  const generated = generateEmployees(employeeCount);
  for (const batch of chunk(generated, 500)) {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.employees)
        .values(batch.map((b) => ({ ...b.employee, organizationId: org.id })))
        .returning();

      await tx.insert(schema.salaryRecords).values(
        inserted.flatMap((e, i) => {
          const source = batch[i];
          if (!source) throw new Error("batch/inserted length mismatch");
          return source.salaryRecords.map((r) => ({
            ...r,
            employeeId: e.id,
            organizationId: org.id,
            createdBy: adminClerkUserId,
          }));
        }),
      );
    });
  }

  console.log(`Seeded ${name}: ${employeeCount} employees`);
}

async function main() {
  const adminClerkUserId = process.env.SEED_ADMIN_CLERK_USER_ID;
  if (!adminClerkUserId) {
    throw new Error("SEED_ADMIN_CLERK_USER_ID env var required - set it to your own Clerk user id");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL env var required");
  }

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  await db.insert(schema.fxRates).values(FX_SNAPSHOT).onConflictDoNothing();
  await seedOrg(db, "ACME Corp", "acme", 10_000, adminClerkUserId);
  await seedOrg(db, "Globex Inc", "globex", 25, adminClerkUserId);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
