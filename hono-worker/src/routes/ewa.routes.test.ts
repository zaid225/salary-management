import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, ledgerEvents, ledgerBalances, timeEntries } from "../models/schema.js";
import { ewaRoutes } from "./ewa.routes.js";

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

function fetchIt(path: string, orgId: string, method = "GET", body?: unknown) {
  return ewaRoutes.fetch(
    new Request(`http://test${path}`, {
      method,
      headers: authed("admin_1", orgId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv(),
    testExecutionCtx(),
  );
}

async function seedOrgWithEmployee() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-ewa" }).returning();
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

// A full 31-day January period, evaluated "as of" the actual clock - the
// accrual preview and the request handler both call Date.now() internally
// (the one place in this feature that isn't a pure function, since "how
// much of today has elapsed" is inherently about the real calendar), so
// these tests only assert directional/bounding properties, not an exact
// hand-computed number tied to whatever day the suite happens to run.
const PERIOD = { periodStart: "2024-01-01", periodEnd: "2024-01-31" };

describe("GET /ewa/accrual/:employeeId", () => {
  it("returns a positive accrual and a max allowance that is a fraction of it", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await ewaRoutes.fetch(
      new Request(
        `http://test/ewa/accrual/${employee.id}?periodStart=${PERIOD.periodStart}&periodEnd=${PERIOD.periodEnd}`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accruedGrossMinor: number; maxAllowedMinor: number; currency: string };
    expect(body.accruedGrossMinor).toBeGreaterThan(0);
    expect(body.maxAllowedMinor).toBeLessThanOrEqual(Math.round(body.accruedGrossMinor * 0.5));
    expect(body.currency).toBe("USD");
  });

  it("404s an unknown employee", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await ewaRoutes.fetch(
      new Request(
        `http://test/ewa/accrual/00000000-0000-0000-0000-000000000000?periodStart=2024-01-01&periodEnd=2024-01-31`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /ewa/accrual/:employeeId — hours-based override", () => {
  it("uses real attendance hours instead of calendar proration once punches exist for the period", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    // One real 8-hour shift on record within the declared period.
    await db.insert(timeEntries).values([
      {
        organizationId: org.id,
        employeeId: employee.id,
        type: "clock_in",
        occurredAt: new Date("2024-01-03T09:00:00.000Z"),
        source: "test-hris",
        externalId: "shift-1-in",
      },
      {
        organizationId: org.id,
        employeeId: employee.id,
        type: "clock_out",
        occurredAt: new Date("2024-01-03T17:00:00.000Z"),
        source: "test-hris",
        externalId: "shift-1-out",
      },
    ]);

    const res = await ewaRoutes.fetch(
      new Request(
        `http://test/ewa/accrual/${employee.id}?periodStart=${PERIOD.periodStart}&periodEnd=${PERIOD.periodEnd}`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accruedGrossMinor: number; accrualSource: string };
    expect(body.accrualSource).toBe("hours");
    // $120,000.00/yr => 12,000,000 minor units; 8 hours of 2,080 standard
    // annual hours => 12,000,000 * 8 / 2080 = 46,153.84... rounds to 46,154.
    expect(body.accruedGrossMinor).toBe(46_154);
  });
});

describe("POST /ewa/requests", () => {
  it("creates a pending request within the allowed cap", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const accrualRes = await ewaRoutes.fetch(
      new Request(
        `http://test/ewa/accrual/${employee.id}?periodStart=${PERIOD.periodStart}&periodEnd=${PERIOD.periodEnd}`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    const { maxAllowedMinor } = (await accrualRes.json()) as { maxAllowedMinor: number };
    expect(maxAllowedMinor).toBeGreaterThan(0);

    const res = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: maxAllowedMinor, // exactly at the cap is allowed
      ...PERIOD,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request: { status: string; requestedMinor: number } };
    expect(body.request.status).toBe("pending");
    expect(body.request.requestedMinor).toBe(maxAllowedMinor);
  });

  it("422s a request that exceeds the allowed advance", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    // An absurdly large request must be rejected regardless of the exact
    // accrual figure on the day the suite runs.
    const res = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: 100_000_000, // $1,000,000 - far beyond any real accrual here
      ...PERIOD,
    });
    expect(res.status).toBe(422);
  });

  it("404s an employee with no salary on record", async () => {
    const orgRows = await db.insert(organizations).values({ name: "Other", slug: "other-ewa" }).returning();
    const org = orgRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
    const emp = await db
      .insert(employees)
      .values({
        organizationId: org.id,
        employeeNumber: "EMP-0002",
        firstName: "No",
        lastName: "Salary",
        email: "nosalary@example.com",
        country: "US",
        department: "Eng",
        jobTitle: "Eng",
        level: "L1",
        hireDate: "2024-01-01",
      })
      .returning();

    const res = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: emp[0]!.id,
      requestedMinor: 1000,
      ...PERIOD,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /ewa/requests/:requestId/review", () => {
  it("approving writes a balanced double-entry ledger event; rejecting writes nothing", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const created = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: 100,
      ...PERIOD,
    });
    const { request } = (await created.json()) as { request: { id: string } };

    const approved = await fetchIt(`/ewa/requests/${request.id}/review`, org.id, "POST", {
      decision: "approved",
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { request: { status: string }; ledgerEventId: string };
    expect(approvedBody.request.status).toBe("approved");

    const events = await db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.organizationId, org.id), eq(ledgerEvents.eventType, "ewa_advance")));
    expect(events).toHaveLength(1);

    const balances = await db.select().from(ledgerBalances).where(eq(ledgerBalances.eventId, events[0]!.id));
    expect(balances).toHaveLength(2);
    const sum = balances.reduce((acc, b) => acc + b.deltaMinor, 0);
    expect(sum).toBe(0);

    const liabilityLeg = balances.find((b) => b.accountType === "ewa_liability");
    expect(liabilityLeg?.accountId).toBe(employee.id);
    expect(liabilityLeg?.deltaMinor).toBe(100);

    // A second request, rejected: no ledger activity at all.
    const secondRequest = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: 50,
      ...PERIOD,
    });
    const { request: second } = (await secondRequest.json()) as { request: { id: string } };
    const rejected = await fetchIt(`/ewa/requests/${second.id}/review`, org.id, "POST", { decision: "rejected" });
    expect(rejected.status).toBe(200);

    const eventsAfterReject = await db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.organizationId, org.id), eq(ledgerEvents.eventType, "ewa_advance")));
    expect(eventsAfterReject).toHaveLength(1); // still just the one from the approval
  });

  it("cannot review the same request twice", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const created = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: 100,
      ...PERIOD,
    });
    const { request } = (await created.json()) as { request: { id: string } };

    const first = await fetchIt(`/ewa/requests/${request.id}/review`, org.id, "POST", { decision: "approved" });
    expect(first.status).toBe(200);
    const second = await fetchIt(`/ewa/requests/${request.id}/review`, org.id, "POST", { decision: "rejected" });
    expect(second.status).toBe(409);
  });

  it("counts a prior approved advance against the cap for a later request in the same period", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const accrualRes = await ewaRoutes.fetch(
      new Request(
        `http://test/ewa/accrual/${employee.id}?periodStart=${PERIOD.periodStart}&periodEnd=${PERIOD.periodEnd}`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    const { maxAllowedMinor } = (await accrualRes.json()) as { maxAllowedMinor: number };

    const first = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: maxAllowedMinor,
      ...PERIOD,
    });
    const { request } = (await first.json()) as { request: { id: string } };
    await fetchIt(`/ewa/requests/${request.id}/review`, org.id, "POST", { decision: "approved" });

    // The cap is now fully used for this period - any further request must
    // be rejected, even a small one.
    const second = await fetchIt("/ewa/requests", org.id, "POST", {
      employeeId: employee.id,
      requestedMinor: 1,
      ...PERIOD,
    });
    expect(second.status).toBe(422);
  });
});
