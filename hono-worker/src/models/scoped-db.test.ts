import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, invitations } from "./schema.js";
import { scopedDb } from "./scoped-db.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

async function seedTwoOrgs() {
  const orgsA = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const orgA = orgsA[0];
  if (!orgA) throw new Error("Failed to create organization A");
  const orgsB = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const orgB = orgsB[0];
  if (!orgB) throw new Error("Failed to create organization B");

  await db.insert(memberships).values([
    { organizationId: orgA.id, clerkUserId: "user_a1", role: "admin", status: "active" },
    { organizationId: orgA.id, clerkUserId: "user_a2", role: "viewer", status: "active" },
    { organizationId: orgB.id, clerkUserId: "user_b1", role: "admin", status: "active" },
  ]);

  await db.insert(invitations).values([
    {
      organizationId: orgA.id,
      email: "pending@a.com",
      role: "viewer",
      token: "token-a-1",
      status: "pending",
      invitedBy: "user_a1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      organizationId: orgB.id,
      email: "pending@b.com",
      role: "viewer",
      token: "token-b-1",
      status: "pending",
      invitedBy: "user_b1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ]);

  return { orgA, orgB };
}

describe("scopedDb", () => {
  it("never returns another organization's memberships or invitations", async () => {
    const { orgA, orgB } = await seedTwoOrgs();

    const scopedA = scopedDb(db, orgA.id);
    const membersA = await scopedA.memberships.listActive();
    expect(membersA).toHaveLength(2);
    expect(membersA.every((m) => m.organizationId === orgA.id)).toBe(true);

    const invitesA = await scopedA.invitations.listPending();
    expect(invitesA).toHaveLength(1);
    const inviteA = invitesA[0];
    if (!inviteA) throw new Error("Expected a pending invitation");
    expect(inviteA.organizationId).toBe(orgA.id);

    const scopedB = scopedDb(db, orgB.id);
    expect(await scopedB.memberships.listActive()).toHaveLength(1);
  });

  it("counts only active admins within the given organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    expect(await scopedA.memberships.countActiveAdmins()).toBe(1);
  });

  it("finds a pending invitation by email, scoped to the organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    const found = await scopedA.invitations.findPendingByEmail("pending@a.com");
    expect(found?.email).toBe("pending@a.com");
    expect(await scopedA.invitations.findPendingByEmail("pending@b.com")).toBeNull();
  });
});
