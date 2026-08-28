import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, auditLog, fxRates } from "../models/schema.js";
import { employeesRoutes } from "./employees.routes.js";

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

async function seedOrgWithEmployee() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-emp" }).returning();
  const org = orgRows[0];
  if (!org) throw new Error("insert did not return a row");
  await db.insert(memberships).values([
    { organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" },
    { organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" },
  ]);
  const empRows = await db
    .insert(employees)
    .values({
      organizationId: org.id,
      employeeNumber: "EMP-0001",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      country: "GB",
      department: "Engineering",
      jobTitle: "Analyst",
      level: "L3",
      hireDate: "2023-01-01",
    })
    .returning();
  const employee = empRows[0];
  if (!employee) throw new Error("insert did not return a row");
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

describe("GET /employees", () => {
  it("lists employees with their current salary", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      employees: { employeeNumber: string; currentSalary: { amount: string } | null }[];
    };
    expect(body.employees).toHaveLength(1);
    expect(body.employees[0]?.employeeNumber).toBe("EMP-0001");
    expect(body.employees[0]?.currentSalary?.amount).toBe("85000.00");
  });

  it("filters by country", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees?country=US", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const body = (await res.json()) as { employees: unknown[] };
    expect(body.employees).toHaveLength(0);
  });

  it("clamps an over-large limit instead of rejecting it", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees?limit=99999", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limit: number };
    // This list caps at 1000, higher than the other lists' 100 - see
    // EmployeeListQuery for why.
    expect(body.limit).toBe(1000);
  });

  it("403s a non-member", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", { headers: authed("stranger", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /employees/:id", () => {
  it("returns the employee profile with full salary history", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}`, { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee: { employeeNumber: string }; salaryHistory: unknown[] };
    expect(body.employee.employeeNumber).toBe("EMP-0001");
    expect(body.salaryHistory).toHaveLength(1);
  });

  it("404s an employee from another org", async () => {
    const { employee } = await seedOrgWithEmployee();
    const otherOrgRows = await db.insert(organizations).values({ name: "Other", slug: "other-org" }).returning();
    const otherOrg = otherOrgRows[0];
    if (!otherOrg) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: otherOrg.id, clerkUserId: "admin_2", role: "admin", status: "active" });

    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}`, { headers: authed("admin_2", otherOrg.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /employees", () => {
  it("creates an employee with its initial salary record, audited", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-create" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({
          employeeNumber: "EMP-1000",
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.com",
          country: "US",
          department: "Engineering",
          jobTitle: "Engineer",
          level: "L4",
          hireDate: "2024-01-01",
          salary: { amount: 120000, currency: "USD", effectiveDate: "2024-01-01", reason: "hire" },
        }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(201);

    const empRows = await db.select().from(employees).where(eq(employees.employeeNumber, "EMP-1000"));
    expect(empRows).toHaveLength(1);
    const created = empRows[0];
    if (!created) throw new Error("expected employee row");

    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.employeeId, created.id));
    expect(salaries).toHaveLength(1);

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, created.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("create");
  });

  it("403s a viewer trying to create an employee", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-create2" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_2", role: "viewer", status: "active" });

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", {
        method: "POST",
        headers: authed("viewer_2", org.id),
        body: JSON.stringify({
          employeeNumber: "EMP-2000",
          firstName: "X",
          lastName: "Y",
          email: "x@example.com",
          country: "US",
          department: "Eng",
          jobTitle: "Eng",
          level: "L1",
          hireDate: "2024-01-01",
          salary: { amount: 1000, currency: "USD", effectiveDate: "2024-01-01", reason: "hire" },
        }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("409s a duplicate employeeNumber within the same org", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({
          employeeNumber: "EMP-0001", // already exists per seedOrgWithEmployee
          firstName: "Dup",
          lastName: "Licate",
          email: "dup@example.com",
          country: "US",
          department: "Eng",
          jobTitle: "Eng",
          level: "L1",
          hireDate: "2024-01-01",
          salary: { amount: 1000, currency: "USD", effectiveDate: "2024-01-01", reason: "hire" },
        }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(409);
  });

  it("400s an invalid body", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees", {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ employeeNumber: "nope" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /employees/:id", () => {
  it("updates profile fields and writes an audit entry with before/after", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}`, {
        method: "PUT",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ department: "Product", jobTitle: "Senior Analyst" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(employees).where(eq(employees.id, employee.id));
    expect(rows[0]?.department).toBe("Product");

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, employee.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("update");
  });

  it("404s an employee id from another org", async () => {
    const { employee } = await seedOrgWithEmployee();
    const otherOrgRows = await db.insert(organizations).values({ name: "Other", slug: "other-put" }).returning();
    const otherOrg = otherOrgRows[0];
    if (!otherOrg) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: otherOrg.id, clerkUserId: "admin_3", role: "admin", status: "active" });

    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}`, {
        method: "PUT",
        headers: authed("admin_3", otherOrg.id),
        body: JSON.stringify({ department: "Hacked" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /employees/:id", () => {
  it("soft-deletes (employmentStatus -> terminated), row still exists", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}`, {
        method: "DELETE",
        headers: authed("admin_1", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(employees).where(eq(employees.id, employee.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.employmentStatus).toBe("terminated");

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, employee.id));
    expect(audits.some((a) => a.action === "delete")).toBe(true);
  });
});

describe("POST /employees/:id/salary", () => {
  it("appends a new salary record without overwriting the old one, audited", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}/salary`, {
        method: "POST",
        headers: authed("admin_1", org.id),
        body: JSON.stringify({ amount: 95000, currency: "GBP", effectiveDate: "2024-06-01", reason: "raise" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(201);

    const history = await db.select().from(salaryRecords).where(eq(salaryRecords.employeeId, employee.id));
    expect(history).toHaveLength(2); // original hire record + this raise

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityType, "salary_record"));
    expect(audits).toHaveLength(1);
  });

  it("404s for an employee in another org", async () => {
    const { employee } = await seedOrgWithEmployee();
    const otherOrgRows = await db.insert(organizations).values({ name: "Other", slug: "other-salary" }).returning();
    const otherOrg = otherOrgRows[0];
    if (!otherOrg) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: otherOrg.id, clerkUserId: "admin_4", role: "admin", status: "active" });

    const res = await employeesRoutes.fetch(
      new Request(`http://test/employees/${employee.id}/salary`, {
        method: "POST",
        headers: authed("admin_4", otherOrg.id),
        body: JSON.stringify({ amount: 1, currency: "USD", effectiveDate: "2024-01-01", reason: "raise" }),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /employees search and sorting", () => {
  it("matches a full name typed as one string", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees?search=Ada%20Lovelace", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    const body = (await res.json()) as { employees: { employeeNumber: string }[] };
    expect(body.employees).toHaveLength(1);
    expect(body.employees[0]?.employeeNumber).toBe("EMP-0001");
  });

  it("matches on last name alone and on email", async () => {
    const { org } = await seedOrgWithEmployee();
    for (const term of ["Lovelace", "ada@example.com"]) {
      const res = await employeesRoutes.fetch(
        new Request(`http://test/employees?search=${encodeURIComponent(term)}`, {
          headers: authed("viewer_1", org.id),
        }),
        testEnv(),
        testExecutionCtx(),
      );
      const body = (await res.json()) as { employees: unknown[] };
      expect(body.employees, `search term: ${term}`).toHaveLength(1);
    }
  });

  it("sorts by current salary, normalized across currencies", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-sort" }).returning();
    const org = orgRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    await db.insert(fxRates).values([
      { currency: "USD", rateToUsd: "1.000000", asOfDate: "2024-01-01" },
      { currency: "GBP", rateToUsd: "2.000000", asOfDate: "2024-01-01" },
    ]);

    const emps = await db
      .insert(employees)
      .values([
        { organizationId: org.id, employeeNumber: "EMP-0001", firstName: "Low", lastName: "Paid", email: "a@x.com", country: "US", department: "Eng", jobTitle: "E", level: "L1", hireDate: "2024-01-01" },
        { organizationId: org.id, employeeNumber: "EMP-0002", firstName: "High", lastName: "Paid", email: "b@x.com", country: "GB", department: "Eng", jobTitle: "E", level: "L1", hireDate: "2024-01-01" },
      ])
      .returning();

    // 60000 GBP at 2.0 is 120000 USD, so it outranks 100000 USD even though
    // the raw number is smaller - that is the whole point of normalizing.
    await db.insert(salaryRecords).values([
      { organizationId: org.id, employeeId: emps[0]!.id, amount: "100000.00", currency: "USD", effectiveDate: "2024-01-01", reason: "hire", createdBy: "viewer_1" },
      { organizationId: org.id, employeeId: emps[1]!.id, amount: "60000.00", currency: "GBP", effectiveDate: "2024-01-01", reason: "hire", createdBy: "viewer_1" },
    ]);

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees?sort=currentSalary&order=desc", {
        headers: authed("viewer_1", org.id),
      }),
      testEnv(),
      testExecutionCtx(),
    );
    const body = (await res.json()) as { employees: { employeeNumber: string }[] };
    expect(body.employees[0]?.employeeNumber).toBe("EMP-0002");
    expect(body.employees[1]?.employeeNumber).toBe("EMP-0001");
  });

  it("allows a page size above 100 but still clamps it", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees?limit=500", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(((await res.json()) as { limit: number }).limit).toBe(500);

    const tooBig = await employeesRoutes.fetch(
      new Request("http://test/employees?limit=99999", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(((await tooBig.json()) as { limit: number }).limit).toBe(1000);
  });
});
