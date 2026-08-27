import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords } from "../models/schema.js";
import { employeesRoutes } from "./employees.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId, "content-type": "text/csv" };
}

async function seedAdminOrg() {
  const rows = await db.insert(organizations).values({ name: "ACME", slug: "acme-import" }).returning();
  const org = rows[0];
  if (!org) throw new Error("insert did not return a row");
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

const CSV_HEADER =
  "employeeNumber,firstName,lastName,email,country,department,jobTitle,level,hireDate,salaryAmount,salaryCurrency";

describe("POST /employees/import", () => {
  it("creates new employees with their initial salary from valid rows", async () => {
    const org = await seedAdminOrg();
    const csv = [
      CSV_HEADER,
      "EMP-3000,Alan,Turing,alan@example.com,GB,Engineering,Analyst,L5,2024-01-01,110000,GBP",
      "EMP-3001,Barbara,Liskov,barbara@example.com,US,Engineering,Analyst,L5,2024-01-01,140000,USD",
    ].join("\n");

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: csv }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; updated: number; failed: unknown[] };
    expect(body.created).toBe(2);
    expect(body.failed).toHaveLength(0);

    const rows = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    expect(rows).toHaveLength(2);

    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.organizationId, org.id));
    expect(salaries).toHaveLength(2);
  });

  it("updates profile fields (not salary) for an existing employeeNumber", async () => {
    const org = await seedAdminOrg();
    const first = [
      CSV_HEADER,
      "EMP-3000,Alan,Turing,alan@example.com,GB,Engineering,Analyst,L5,2024-01-01,110000,GBP",
    ].join("\n");
    await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: first }),
      testEnv(),
      testExecutionCtx(),
    );

    const second = [
      CSV_HEADER,
      "EMP-3000,Alan,Turing,alan@example.com,GB,Product,Senior Analyst,L6,2024-01-01,999999,GBP",
    ].join("\n");
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: second }),
      testEnv(),
      testExecutionCtx(),
    );
    const body = (await res.json()) as { created: number; updated: number };
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);

    const rows = await db.select().from(employees).where(eq(employees.employeeNumber, "EMP-3000"));
    expect(rows[0]?.department).toBe("Product");

    // salary was NOT touched by the re-import (still the original 110000, one row)
    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.organizationId, org.id));
    expect(salaries).toHaveLength(1);
    expect(salaries[0]?.amount).toBe("110000.00");
  });

  it("reports per-row errors without failing the whole import", async () => {
    const org = await seedAdminOrg();
    const csv = [
      CSV_HEADER,
      "EMP-3000,Alan,Turing,alan@example.com,GB,Engineering,Analyst,L5,2024-01-01,110000,GBP",
      "BAD-NUMBER,X,Y,not-an-email,GB,Eng,Analyst,L1,2024-01-01,1000,GBP",
    ].join("\n");

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: csv }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; failed: { row: number; error: string }[] };
    expect(body.created).toBe(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.row).toBe(2); // 1-indexed data rows, header not counted
  });

  it("resolves a same-batch duplicate employeeNumber as create-then-update, without aborting the rest of the batch", async () => {
    const org = await seedAdminOrg();
    const csv = [
      CSV_HEADER,
      "EMP-3000,Alan,Turing,alan@example.com,GB,Engineering,Analyst,L5,2024-01-01,110000,GBP",
      "EMP-3000,Alan,Turing,alan@example.com,GB,Product,Senior Analyst,L6,2024-01-01,110000,GBP",
      "EMP-3001,Barbara,Liskov,barbara@example.com,US,Engineering,Analyst,L5,2024-01-01,140000,USD",
    ].join("\n");

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: csv }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; updated: number; failed: unknown[] };

    // Row 1 creates EMP-3000; row 2 (same number, later in the same batch)
    // finds row 1's just-inserted record via the tx-scoped lookup and takes
    // the update branch. Row 3 still succeeds - the duplicate does not abort
    // the rest of the batch.
    expect(body.created).toBe(2);
    expect(body.updated).toBe(1);
    expect(body.failed).toHaveLength(0);

    const rows = await db.select().from(employees).where(eq(employees.employeeNumber, "EMP-3000"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.department).toBe("Product"); // row 2's update won

    const all = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    expect(all).toHaveLength(2);

    // salary was only ever written once for EMP-3000 (on the initial create)
    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.employeeId, rows[0]!.id));
    expect(salaries).toHaveLength(1);
  });

  it("403s a viewer", async () => {
    const org = await seedAdminOrg();
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", {
        method: "POST",
        headers: authed("viewer_1", org.id),
        body: CSV_HEADER,
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /employees/import at volume", () => {
  it("imports 250 rows in one request, then re-imports them as updates", async () => {
    const org = await seedAdminOrg();
    const rows = Array.from(
      { length: 250 },
      (_, i) =>
        `EMP-${String(i + 1).padStart(6, "0")},First${i},Last${i},user${i}@example.com,US,Engineering,Engineer,L3,2024-01-01,${90000 + i},USD`,
    );
    const csv = [CSV_HEADER, ...rows].join("\n");

    const started = Date.now();
    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: csv }),
      testEnv(),
      testExecutionCtx(),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number; updated: number; failed: unknown[] };
    expect(body.created).toBe(250);
    expect(body.updated).toBe(0);
    expect(body.failed).toHaveLength(0);
    console.log(`[perf] 250-row first import: ${elapsed}ms`);

    const stored = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    expect(stored).toHaveLength(250);
    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.organizationId, org.id));
    expect(salaries).toHaveLength(250);

    // Re-importing the same file is a pure update path: no new employees, no
    // new salary rows.
    const second = await employeesRoutes.fetch(
      new Request("http://test/employees/import", { method: "POST", headers: authed("admin_1", org.id), body: csv }),
      testEnv(),
      testExecutionCtx(),
    );
    const secondBody = (await second.json()) as { created: number; updated: number };
    expect(secondBody.created).toBe(0);
    expect(secondBody.updated).toBe(250);

    const salariesAfter = await db.select().from(salaryRecords).where(eq(salaryRecords.organizationId, org.id));
    expect(salariesAfter).toHaveLength(250);
  });
});
