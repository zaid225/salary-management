import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { membersRoutes } from "./members.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId, "content-type": "application/json" };
}

async function seedOrg() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  const org = orgRows[0];
  if (!org) throw new Error("insert did not return a row");

  const rows = await db
    .insert(memberships)
    .values([
      { organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" },
      { organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" },
    ])
    .returning();
  const admin = rows[0];
  const viewer = rows[1];
  if (!admin || !viewer) throw new Error("insert did not return both rows");

  return { org, admin, viewer };
}

type MembersBody = { members: unknown[] };

describe("GET /organizations/:orgId/members", () => {
  it("lists active members of the org", async () => {
    const { org } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members`, { headers: authed("admin_1", org.id) }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersBody;
    expect(body.members).toHaveLength(2);
  });
});

describe("PATCH /organizations/:orgId/members/:membershipId", () => {
  it("changes a member's role", async () => {
    const { org, viewer } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${viewer.id}`, {
        method: "PATCH",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ role: "admin" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(memberships).where(eq(memberships.id, viewer.id));
    const updated = rows[0];
    if (!updated) throw new Error("membership row not found");
    expect(updated.role).toBe("admin");
  });

  it("409s demoting the org's last admin", async () => {
    const { org, admin } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${admin.id}`, {
        method: "PATCH",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(409);
    const rows = await db.select().from(memberships).where(eq(memberships.id, admin.id));
    const unchanged = rows[0];
    if (!unchanged) throw new Error("membership row not found");
    expect(unchanged.role).toBe("admin");
  });
});

describe("DELETE /organizations/:orgId/members/:membershipId", () => {
  it("soft-removes a member (status, not row deletion)", async () => {
    const { org, viewer } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${viewer.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const rows = await db.select().from(memberships).where(eq(memberships.id, viewer.id));
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.status).toBe("removed");
  });

  it("409s removing the org's last admin", async () => {
    const { org, admin } = await seedOrg();
    const res = await membersRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/members/${admin.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(409);
    const rows = await db.select().from(memberships).where(eq(memberships.id, admin.id));
    const row = rows[0];
    if (!row) throw new Error("membership row not found");
    expect(row.status).toBe("active");
  });
});
