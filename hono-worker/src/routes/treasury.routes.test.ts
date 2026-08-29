import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, payrollRuns, ewaRequests } from "../models/schema.js";
import { treasuryRoutes } from "./treasury.routes.js";

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

function get(orgId: string, startingCashBalanceMinor?: number) {
  const qs = startingCashBalanceMinor === undefined ? "" : `?startingCashBalanceMinor=${startingCashBalanceMinor}`;
  return treasuryRoutes.fetch(
    new Request(`http://test/treasury/forecast${qs}`, { headers: authed("admin_1", orgId) }),
    testEnv(),
    testExecutionCtx(),
  );
}

async function seedOrgWithEmployee() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-treasury" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  const emp = await db
    .insert(employees)
    .values({
      organizationId: org.id,
      employeeNumber: "EMP-0001",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      country: "US",
      department: "Engineering",
      jobTitle: "Engineer",
      level: "L4",
      hireDate: "2024-01-01",
    })
    .returning();
  const employee = emp[0]!;
  await db.insert(salaryRecords).values({
    organizationId: org.id,
    employeeId: employee.id,
    amount: "120000.00",
    currency: "USD",
    effectiveDate: "2024-01-01",
    reason: "hire",
    createdBy: "admin_1",
  });
  return { org, employee };
}

function currentMonthBounds(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { periodStart: `${y}-${pad(m + 1)}-01`, periodEnd: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

describe("GET /treasury/forecast", () => {
  it("400s when startingCashBalanceMinor is missing", async () => {
    const orgRows = await db.insert(organizations).values({ name: "X", slug: "x-treasury" }).returning();
    const org = orgRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
    const res = await get(org.id);
    expect(res.status).toBe(400);
  });

  it("with no employees, no runs, no requests: projected balance equals the starting balance", async () => {
    const orgRows = await db.insert(organizations).values({ name: "Empty Org", slug: "empty-treasury" }).returning();
    const org = orgRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });

    const res = await get(org.id, 1_000_000_00);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectedBalanceMinor: number;
      stressTestBalanceMinor: number;
      atRisk: boolean;
    };
    expect(body.projectedBalanceMinor).toBe(1_000_000_00);
    expect(body.stressTestBalanceMinor).toBe(1_000_000_00);
    expect(body.atRisk).toBe(false);
  });

  it("counts a calculated (unposted) payroll run's total as a known obligation", async () => {
    const { org } = await seedOrgWithEmployee();
    await db.insert(payrollRuns).values({
      organizationId: org.id,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "US-CA",
      status: "calculated",
      totalGrossMinor: 100_000,
      totalNetMinor: 80_000,
      createdBy: "admin_1",
    });
    // A posted run must NOT count - it already moved through the ledger.
    await db.insert(payrollRuns).values({
      organizationId: org.id,
      periodStart: "2023-12-01",
      periodEnd: "2023-12-31",
      jurisdiction: "US-CA",
      status: "posted",
      totalGrossMinor: 999_999,
      totalNetMinor: 999_999,
      createdBy: "admin_1",
    });

    const res = await get(org.id, 1_000_000);
    const body = (await res.json()) as { inputs: { knownObligationsMinor: number } };
    expect(body.inputs.knownObligationsMinor).toBe(80_000);
  });

  it("counts pending EWA requests but not rejected ones", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    await db.insert(ewaRequests).values([
      {
        organizationId: org.id,
        employeeId: employee.id,
        requestedMinor: 5_000,
        periodStart: "2024-01-01",
        periodEnd: "2024-01-31",
        accruedAtRequestMinor: 10_000,
        maxAllowedAtRequestMinor: 5_000,
        currency: "USD",
        status: "pending",
        requestedBy: "admin_1",
      },
      {
        organizationId: org.id,
        employeeId: employee.id,
        requestedMinor: 9_999,
        periodStart: "2024-01-01",
        periodEnd: "2024-01-31",
        accruedAtRequestMinor: 10_000,
        maxAllowedAtRequestMinor: 5_000,
        currency: "USD",
        status: "rejected",
        requestedBy: "admin_1",
      },
    ]);

    const res = await get(org.id, 1_000_000);
    const body = (await res.json()) as { inputs: { pendingEwaMinor: number; pendingEwaCount: number } };
    expect(body.inputs.pendingEwaMinor).toBe(5_000);
    expect(body.inputs.pendingEwaCount).toBe(1);
  });

  it("an active salaried employee with no EWA activity this month has positive stress-test headroom", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await get(org.id, 1_000_000_00);
    const body = (await res.json()) as { inputs: { potentialAdditionalEwaMinor: number } };
    expect(body.inputs.potentialAdditionalEwaMinor).toBeGreaterThan(0);
  });

  it("an already-maxed-out EWA request this month reduces remaining headroom to zero for that employee", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const { periodStart, periodEnd } = currentMonthBounds();
    // Absurdly large approved advance this month - caps this employee's
    // remaining headroom at exactly 0 regardless of the exact accrual figure.
    await db.insert(ewaRequests).values({
      organizationId: org.id,
      employeeId: employee.id,
      requestedMinor: 100_000_000,
      periodStart,
      periodEnd,
      accruedAtRequestMinor: 100_000_000,
      maxAllowedAtRequestMinor: 100_000_000,
      currency: "USD",
      status: "approved",
      requestedBy: "admin_1",
      reviewedBy: "admin_1",
      reviewedAt: new Date(),
    });

    const res = await get(org.id, 1_000_000_00);
    const body = (await res.json()) as { inputs: { potentialAdditionalEwaMinor: number } };
    expect(body.inputs.potentialAdditionalEwaMinor).toBe(0);
  });
});
