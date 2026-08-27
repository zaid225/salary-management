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

describe("salary-domain integration, end to end", () => {
  it("an employee created via the assembled app is visible in its org's list but not another org's", async () => {
    const createOrgA = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("admin_a"),
        body: JSON.stringify({ name: "Org A" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    const orgA = ((await createOrgA.json()) as { organization: { id: string } }).organization;

    const createOrgB = await app.fetch(
      new Request("http://test/api/organizations", {
        method: "POST",
        headers: authed("admin_b"),
        body: JSON.stringify({ name: "Org B" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    const orgB = ((await createOrgB.json()) as { organization: { id: string } }).organization;

    const createEmp = await app.fetch(
      new Request("http://test/api/employees", {
        method: "POST",
        headers: authed("admin_a", orgA.id),
        body: JSON.stringify({
          employeeNumber: "EMP-9000",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          country: "GB",
          department: "Engineering",
          jobTitle: "Analyst",
          level: "L3",
          hireDate: "2024-01-01",
          salary: { amount: 90000, currency: "GBP", effectiveDate: "2024-01-01", reason: "hire" },
        }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(createEmp.status).toBe(201);

    const listA = await app.fetch(
      new Request("http://test/api/employees", { headers: authed("admin_a", orgA.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const bodyA = (await listA.json()) as { employees: unknown[] };
    expect(bodyA.employees).toHaveLength(1);

    const listB = await app.fetch(
      new Request("http://test/api/employees", { headers: authed("admin_b", orgB.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const bodyB = (await listB.json()) as { employees: unknown[] };
    expect(bodyB.employees).toHaveLength(0);

    // No fx_rates seeded here, so the analytics JOIN excludes the GBP-paid
    // employee entirely - headcount 0, not a 500. An unrecognized currency
    // must never blank out the whole dashboard.
    const analyticsA = await app.fetch(
      new Request("http://test/api/analytics/summary", { headers: authed("admin_a", orgA.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(analyticsA.status).toBe(200);
    const analyticsBodyA = (await analyticsA.json()) as { headcount: number };
    expect(analyticsBodyA.headcount).toBe(0);

    // The audit trail for that create is readable through the mounted app.
    const auditA = await app.fetch(
      new Request("http://test/api/audit-log", { headers: authed("admin_a", orgA.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const auditBodyA = (await auditA.json()) as { entries: { action: string }[] };
    expect(auditBodyA.entries).toHaveLength(1);
    expect(auditBodyA.entries[0]?.action).toBe("create");
  });
});
