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

describe("GET /organizations/:orgId/invitations", () => {
  it("lists pending invitations for the org, paginated", async () => {
    const org = await seedAdminOrg();
    await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "pending@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }),
      testExecutionCtx(),
    );

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        headers: authed("admin_1", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invitations: { email: string }[]; limit: number };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.email).toBe("pending@example.com");
    expect(body.limit).toBe(25);
  });

  it("403s a non-member", async () => {
    const org = await seedAdminOrg();
    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        headers: authed("stranger", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /organizations/:orgId/invitations/:invitationId", () => {
  it("revokes a pending invitation, and its token then fails to accept", async () => {
    const org = await seedAdminOrg();
    const created = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "revokeme@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }),
      testExecutionCtx(),
    );
    const invite = ((await created.json()) as InvitationBody).invitation;

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations/${invite.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(invitations).where(eq(invitations.id, invite.id));
    expect(rows[0]?.status).toBe("revoked");

    // The revoked token is no longer redeemable.
    const accept = await invitationsRoutes.fetch(
      new Request(`http://test/invitations/${rows[0]!.token}/accept`, {
        method: "POST",
        headers: authed("someone_else"),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(accept.status).toBe(410);
  });

  it("403s a viewer", async () => {
    const org = await seedAdminOrg();
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations/00000000-0000-0000-0000-000000000001`, {
        method: "DELETE",
        headers: authed("viewer_1", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("404s an invitation belonging to another org", async () => {
    const org = await seedAdminOrg();
    const otherRows = await db.insert(organizations).values({ name: "Other", slug: "other-revoke" }).returning();
    const other = otherRows[0];
    if (!other) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: other.id, clerkUserId: "admin_2", role: "admin", status: "active" });

    const created = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "target@example.com", role: "viewer" }),
      }),
      testEnv({ POSTMARK_SERVER_TOKEN: "tok" }),
      testExecutionCtx(),
    );
    const invite = ((await created.json()) as InvitationBody).invitation;

    const res = await invitationsRoutes.fetch(
      new Request(`http://test/organizations/${other.id}/invitations/${invite.id}`, {
        method: "DELETE",
        headers: authed("admin_2", other.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});
