import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, auditLog } from "../models/schema.js";
import { auditRoutes } from "./audit.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId };
}

describe("GET /audit-log", () => {
  it("lists this org's audit entries, newest first, paginated", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-audit-route" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    await db.insert(auditLog).values({
      organizationId: org.id,
      actorClerkUserId: "admin_1",
      action: "create",
      entityType: "employee",
      entityId: org.id,
      before: null,
      after: { n: 1 },
    });
    await db.insert(auditLog).values({
      organizationId: org.id,
      actorClerkUserId: "admin_1",
      action: "update",
      entityType: "employee",
      entityId: org.id,
      before: { n: 1 },
      after: { n: 2 },
    });

    const res = await auditRoutes.fetch(
      new Request("http://test/audit-log", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { action: string }[] };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]?.action).toBe("update"); // newest first
  });

  it("filters by entityId", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-audit-route2" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    const targetId = "00000000-0000-0000-0000-000000000001";
    const otherId = "00000000-0000-0000-0000-000000000002";
    await db.insert(auditLog).values([
      {
        organizationId: org.id,
        actorClerkUserId: "admin_1",
        action: "create",
        entityType: "employee",
        entityId: targetId,
        before: null,
        after: {},
      },
      {
        organizationId: org.id,
        actorClerkUserId: "admin_1",
        action: "create",
        entityType: "employee",
        entityId: otherId,
        before: null,
        after: {},
      },
    ]);

    const res = await auditRoutes.fetch(
      new Request(`http://test/audit-log?entityId=${targetId}`, { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const body = (await res.json()) as { entries: { entityId: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.entityId).toBe(targetId);
  });

  it("400s an entityId that isn't a uuid", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-audit-route3" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });

    const res = await auditRoutes.fetch(
      new Request("http://test/audit-log?entityId=not-a-uuid", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });
});
