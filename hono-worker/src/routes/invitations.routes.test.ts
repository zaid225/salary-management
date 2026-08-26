import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, invitations } from "../models/schema.js";
import { invitationsRoutes } from "./invitations.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
  vi.restoreAllMocks();
  global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${userId}`, "content-type": "application/json" };
  if (orgId) headers["X-Org-Id"] = orgId;
  return headers;
}

async function seedAdminOrg() {
  const rows = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  const org = rows[0];
  if (!org) throw new Error("insert did not return a row");
  await db.insert(memberships).values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

type InvitationBody = { invitation: { id: string; email: string }; acceptUrl: string };

describe("POST /organizations/:orgId/invitations", () => {
  it("creates a pending invitation and emails it", async () => {
    const org = await seedAdminOrg();
    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "new@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as InvitationBody;
    expect(body.invitation.email).toBe("new@example.com");
    expect(body.acceptUrl).toMatch(/\/accept-invite\//);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: re-inviting the same pending email returns the existing invite without re-sending", async () => {
    const org = await seedAdminOrg();
    const first = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "dup@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    const firstBody = (await first.json()) as InvitationBody;

    const second = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "dup@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }), testExecutionCtx(),
    );
    const secondBody = (await second.json()) as InvitationBody;

    expect(second.status).toBe(200);
    expect(secondBody.invitation.id).toBe(firstBody.invitation.id);
    expect(global.fetch).toHaveBeenCalledTimes(1); // not re-sent
  });

  it("403s a non-admin (viewer) trying to invite", async () => {
    const org = await seedAdminOrg();
    await db.insert(memberships).values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("viewer_1", org.id),
        body: JSON.stringify({ email: "x@example.com", role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /invitations/:token/accept", () => {
  it("creates an active membership and marks the invite accepted", async () => {
    const org = await seedAdminOrg();
    const inviteRows = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "invitee@example.com",
        role: "viewer",
        token: "tok_accept_1",
        status: "pending",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const invite = inviteRows[0];
    if (!invite) throw new Error("insert did not return a row");

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, {
        method: "POST",
        headers: authed("new_user"),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);

    const membershipRows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.clerkUserId, "new_user"));
    const membership = membershipRows[0];
    expect(membership).toMatchObject({ organizationId: org.id, role: "viewer", status: "active" });

    const updatedInviteRows = await db.select().from(invitations).where(eq(invitations.id, invite.id));
    const updatedInvite = updatedInviteRows[0];
    if (!updatedInvite) throw new Error("invite row missing");
    expect(updatedInvite.status).toBe("accepted");
  });

  it("410s on an already-accepted invite", async () => {
    const org = await seedAdminOrg();
    const inviteRows = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "used@example.com",
        role: "viewer",
        token: "tok_used",
        status: "accepted",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    const invite = inviteRows[0];
    if (!invite) throw new Error("insert did not return a row");

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(410);
  });

  it("410s on an expired invite", async () => {
    const org = await seedAdminOrg();
    const inviteRows = await db
      .insert(invitations)
      .values({
        organizationId: org.id,
        email: "expired@example.com",
        role: "viewer",
        token: "tok_expired",
        status: "pending",
        invitedBy: "admin_1",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();
    const invite = inviteRows[0];
    if (!invite) throw new Error("insert did not return a row");

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${invite.token}/accept`, { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(410);
  });

  it("404s on an unknown token", async () => {
    const res = await invitationsRoutes.fetch(
      new Request("http://test/invitations/does-not-exist/accept", { method: "POST", headers: authed("someone") }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});
