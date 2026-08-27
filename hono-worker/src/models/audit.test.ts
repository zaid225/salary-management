import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, auditLog } from "./schema.js";
import { writeAudit } from "./audit.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

describe("writeAudit", () => {
  it("inserts a row with the given before/after snapshot", async () => {
    const rows = await db.insert(organizations).values({ name: "ACME", slug: "acme-audit-test" }).returning();
    const org = rows[0];
    if (!org) throw new Error("insert did not return a row");

    await db.transaction(async (tx) => {
      await writeAudit(tx, {
        organizationId: org.id,
        actorClerkUserId: "user_1",
        action: "create",
        entityType: "employee",
        entityId: org.id, // any uuid for the test
        before: null,
        after: { name: "test" },
      });
    });

    const entries = await db.select().from(auditLog).where(eq(auditLog.organizationId, org.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("create");
    expect(entries[0]?.after).toEqual({ name: "test" });
  });

  it("rolls back with the transaction it is part of", async () => {
    const rows = await db.insert(organizations).values({ name: "ACME", slug: "acme-audit-rollback" }).returning();
    const org = rows[0];
    if (!org) throw new Error("insert did not return a row");

    await expect(
      db.transaction(async (tx) => {
        await writeAudit(tx, {
          organizationId: org.id,
          actorClerkUserId: "user_1",
          action: "create",
          entityType: "employee",
          entityId: org.id,
          before: null,
          after: {},
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const entries = await db.select().from(auditLog).where(eq(auditLog.organizationId, org.id));
    expect(entries).toHaveLength(0);
  });
});
