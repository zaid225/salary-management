import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "./schema.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

describe("schema", () => {
  it("persists an organization and its membership", async () => {
    const [org] = await db.insert(organizations).values({ name: "ACME Corp", slug: "acme" }).returning();

    await db.insert(memberships).values({
      organizationId: org.id,
      clerkUserId: "user_1",
      role: "admin",
      status: "active",
    });

    const rows = await db.select().from(memberships).where(eq(memberships.organizationId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("admin");
  });
});
