import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import {
  organizations,
  memberships,
  employees,
  salaryRecords,
  ledgerEvents,
  ledgerBalances,
  payrollRunLines,
} from "../models/schema.js";
import { payrollRunsRoutes } from "./payroll-runs.routes.js";

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

async function seedOrgWithEmployees() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-payroll-run" }).returning();
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

function post(path: string, orgId: string, body?: unknown) {
  return payrollRunsRoutes.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: authed("admin_1", orgId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv(),
    testExecutionCtx(),
  );
}

describe("payroll run lifecycle: draft -> calculated -> posted", () => {
  it("walks the full pipeline and produces balanced double-entry ledger rows", async () => {
    const { org, employee } = await seedOrgWithEmployees();

    const created = await post("/payroll-runs", org.id, {
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "US-CA",
    });
    expect(created.status).toBe(201);
    const { run } = (await created.json()) as { run: { id: string; status: string } };
    expect(run.status).toBe("draft");

    // Nothing calculated yet - no lines, no ledger activity.
    const beforeCalc = await db.select().from(payrollRunLines).where(eq(payrollRunLines.payrollRunId, run.id));
    expect(beforeCalc).toHaveLength(0);

    const calculated = await post(`/payroll-runs/${run.id}/calculate`, org.id);
    expect(calculated.status).toBe(200);
    const calcBody = (await calculated.json()) as { run: { status: string; totalNetMinor: number }; lineCount: number };
    expect(calcBody.run.status).toBe("calculated");
    expect(calcBody.lineCount).toBe(1);
    expect(calcBody.run.totalNetMinor).toBeGreaterThan(0);

    // Calculating never touches the ledger - it is pure computation + a
    // draft snapshot until explicitly posted.
    const ledgerBeforePost = await db.select().from(ledgerEvents).where(eq(ledgerEvents.organizationId, org.id));
    expect(ledgerBeforePost).toHaveLength(0);

    const posted = await post(`/payroll-runs/${run.id}/post`, org.id);
    expect(posted.status).toBe(200);
    const postBody = (await posted.json()) as { run: { status: string }; paychecksIssued: number };
    expect(postBody.run.status).toBe("posted");
    expect(postBody.paychecksIssued).toBe(1);

    const events = await db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.organizationId, org.id), eq(ledgerEvents.eventType, "paycheck_issued")));
    expect(events).toHaveLength(1);
    expect(events[0]?.entityType).toBe("payroll_run");

    // Double-entry: every ledger event's balance legs sum to exactly zero.
    const balances = await db.select().from(ledgerBalances).where(eq(ledgerBalances.eventId, events[0]!.id));
    expect(balances).toHaveLength(3);
    const sum = balances.reduce((acc, b) => acc + b.deltaMinor, 0);
    expect(sum).toBe(0);

    const employeeLeg = balances.find((b) => b.accountType === "employee_gross");
    expect(employeeLeg?.accountId).toBe(employee.id);
    expect(employeeLeg!.deltaMinor).toBeGreaterThan(0);
  });

  it("cannot post a run that has not been calculated", async () => {
    const { org } = await seedOrgWithEmployees();
    const created = await post("/payroll-runs", org.id, {
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "US-CA",
    });
    const { run } = (await created.json()) as { run: { id: string } };

    const res = await post(`/payroll-runs/${run.id}/post`, org.id);
    expect(res.status).toBe(409);
  });

  it("cannot post the same run twice", async () => {
    const { org } = await seedOrgWithEmployees();
    const created = await post("/payroll-runs", org.id, {
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "US-CA",
    });
    const { run } = (await created.json()) as { run: { id: string } };
    await post(`/payroll-runs/${run.id}/calculate`, org.id);
    const first = await post(`/payroll-runs/${run.id}/post`, org.id);
    expect(first.status).toBe(200);

    const second = await post(`/payroll-runs/${run.id}/post`, org.id);
    expect(second.status).toBe(409);

    // Confirms it wasn't just rejected at the HTTP layer - the ledger only
    // has one event's worth of balance rows, not two.
    const events = await db.select().from(ledgerEvents).where(eq(ledgerEvents.organizationId, org.id));
    expect(events).toHaveLength(1);
  });

  it("recalculating a draft run replaces its lines rather than duplicating them", async () => {
    const { org } = await seedOrgWithEmployees();
    const created = await post("/payroll-runs", org.id, {
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "US-CA",
    });
    const { run } = (await created.json()) as { run: { id: string } };

    await post(`/payroll-runs/${run.id}/calculate`, org.id);
    await post(`/payroll-runs/${run.id}/calculate`, org.id);

    const lines = await db.select().from(payrollRunLines).where(eq(payrollRunLines.payrollRunId, run.id));
    expect(lines).toHaveLength(1); // still one line, not two
  });

  it("flags an employee in an unsupported jurisdiction rather than silently skipping totals", async () => {
    const { org } = await seedOrgWithEmployees();
    const created = await post("/payroll-runs", org.id, {
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      jurisdiction: "FR" as unknown as "US-CA", // bypass the enum for this test's purpose via runtime schema
    });
    // The zod enum genuinely rejects "FR" - this proves the API boundary
    // itself refuses an unsupported jurisdiction rather than accepting it
    // and failing silently downstream.
    expect(created.status).toBe(400);
  });
});
