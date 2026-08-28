import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, aiProposals, piiTokens } from "../models/schema.js";
import { payrollRoutes } from "./payroll.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId, "content-type": "application/json" };
}

const FIXTURE_NAME = { first: "Ada", last: "Lovelace" };
const FIXTURE_EMAIL = "ada.lovelace.fixture@example.com";

async function seedOrgWithEmployee() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-payroll" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values([
      { organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" },
      { organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" },
    ]);
  const empRows = await db
    .insert(employees)
    .values({
      organizationId: org.id,
      employeeNumber: "EMP-0001",
      firstName: FIXTURE_NAME.first,
      lastName: FIXTURE_NAME.last,
      email: FIXTURE_EMAIL,
      country: "GB",
      department: "Engineering",
      jobTitle: "Analyst",
      level: "L3",
      hireDate: "2023-01-01",
    })
    .returning();
  const employee = empRows[0]!;
  await db.insert(salaryRecords).values({
    organizationId: org.id,
    employeeId: employee.id,
    amount: "85000.00",
    currency: "GBP",
    effectiveDate: "2023-01-01",
    reason: "hire",
    createdBy: "admin_1",
  });
  return { org, employee };
}

describe("POST /payroll/preflight-audit", () => {
  it("returns 202 with a pending proposal and never sends raw PII downstream", async () => {
    const { org } = await seedOrgWithEmployee();

    // No OPENROUTER_API_KEY in testEnv() - complete() degrades to
    // { ok: false }, which is exactly the path this test needs: it proves
    // tokenization happens *before* any model call is attempted, and that a
    // failed model call still produces a proposal row rather than a 500.
    const res = await payrollRoutes.fetch(
      new Request("http://test/payroll/preflight-audit", {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ periodStart: "2024-01-01", periodEnd: "2024-01-31" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { proposal: { id: string; status: string }; jobId: string };
    expect(body.proposal.status).toBe("pending");

    const proposals = await db.select().from(aiProposals).where(eq(aiProposals.id, body.proposal.id));
    expect(proposals).toHaveLength(1);

    // The actual proof of Rule #5: nothing anywhere in the stored proposal
    // (which is exactly what a real LLM call would have received as its
    // prompt) contains the fixture's raw name or email.
    const serialized = JSON.stringify(proposals[0]);
    expect(serialized).not.toContain(FIXTURE_NAME.first);
    expect(serialized).not.toContain(FIXTURE_NAME.last);
    expect(serialized).not.toContain(FIXTURE_EMAIL);

    // A token row was created for the tokenization step, and its ciphertext
    // is not the plaintext name either (PII_ENCRYPTION_KEY unset in tests -
    // this is the documented "still tokenizes, mapping not yet reversible"
    // degrade path from lib/pii.ts).
    const tokens = await db.select().from(piiTokens).where(eq(piiTokens.organizationId, org.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.ciphertext).not.toContain(FIXTURE_NAME.first);
  });

  it("403s a viewer", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await payrollRoutes.fetch(
      new Request("http://test/payroll/preflight-audit", {
        method: "POST",
        headers: authed("viewer_1", org.id),
        body: JSON.stringify({ periodStart: "2024-01-01", periodEnd: "2024-01-31" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("400s when there is nothing to audit", async () => {
    const orgRows = await db.insert(organizations).values({ name: "Empty Co", slug: "empty-payroll" }).returning();
    const org = orgRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "admin_2", role: "admin", status: "active" });

    const res = await payrollRoutes.fetch(
      new Request("http://test/payroll/preflight-audit", {
        method: "POST",
        headers: authed("admin_2", org.id),
        body: JSON.stringify({ periodStart: "2024-01-01", periodEnd: "2024-01-31" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /ai-proposals/:proposalId/review", () => {
  it("records a sign-off hash and never lets the same proposal be reviewed twice", async () => {
    const { org } = await seedOrgWithEmployee();
    const created = await payrollRoutes.fetch(
      new Request("http://test/payroll/preflight-audit", {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ periodStart: "2024-01-01", periodEnd: "2024-01-31" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    const { proposal } = (await created.json()) as { proposal: { id: string } };

    const res = await payrollRoutes.fetch(
      new Request(`http://test/ai-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ decision: "approved" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { status: string; signOffHash: string | null } };
    expect(body.proposal.status).toBe("approved");
    expect(body.proposal.signOffHash).toMatch(/^[0-9a-f]{64}$/);

    const again = await payrollRoutes.fetch(
      new Request(`http://test/ai-proposals/${proposal.id}/review`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ decision: "approved" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(again.status).toBe(409);
  });
});
