import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../test-utils/db.js";
import app from "./index.js";

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

describe("cross-tenant isolation, end to end", () => {
  it("a member of org A cannot read org B's members even with a valid token", async () => {
    const createA = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("user_a"),
        body: JSON.stringify({ name: "Org A" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const orgA = ((await createA.json()) as { organization: { id: string } }).organization;

    const createB = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("user_b"),
        body: JSON.stringify({ name: "Org B" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const orgB = ((await createB.json()) as { organization: { id: string } }).organization;

    // user_a, a real member of org A, tries org B's member list using org B's id.
    const res = await app.fetch(
      new Request(`http://test/api/organizations/${orgB.id}/members`, {
        headers: authed("user_a", orgB.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);

    // Sanity: user_a *can* read org A's members.
    const okRes = await app.fetch(
      new Request(`http://test/api/organizations/${orgA.id}/members`, {
        headers: authed("user_a", orgA.id),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(okRes.status).toBe(200);
  });

  it("invite -> accept -> membership flow works end to end", async () => {
    const createRes = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("admin_1"),
        body: JSON.stringify({ name: "ACME" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const org = ((await createRes.json()) as { organization: { id: string } }).organization;

    const inviteRes = await app.fetch(
      new Request(`http://test/api/organizations/${org.id}/invitations`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ email: "new@example.com", role: "viewer" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    const invite = ((await inviteRes.json()) as { invitation: { token: string } }).invitation;

    const acceptRes = await app.fetch(
      new Request(`http://test/api/invitations/${invite.token}/accept`, {
        method: "POST",
        headers: authed("new_user"),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(acceptRes.status).toBe(200);

    const listRes = await app.fetch(
      new Request("http://test/api/organizations", { headers: authed("new_user") }),
      testEnv(), testExecutionCtx(),
    );
    const orgs = (
      (await listRes.json()) as {
        organizations: { organization: { id: string }; role: string }[];
      }
    ).organizations;
    expect(orgs).toHaveLength(1);
    const first = orgs[0];
    if (!first) throw new Error("expected at least one organization membership");
    expect(first.organization.id).toBe(org.id);
    expect(first.role).toBe("viewer");
  });
});
