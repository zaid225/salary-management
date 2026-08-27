import { describe, it, expect, afterAll, beforeEach } from "vitest";
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
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId };
}

describe("GET /employees/export", () => {
  it("returns a CSV of the current employee view, respecting filters", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-export" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });

    const empRows = await db
      .insert(employees)
      .values([
        {
          organizationId: org.id,
          employeeNumber: "EMP-0001",
          firstName: "A",
          lastName: "B",
          email: "a@x.com",
          country: "US",
          department: "Eng",
          jobTitle: "Eng",
          level: "L1",
          hireDate: "2024-01-01",
        },
        {
          organizationId: org.id,
          employeeNumber: "EMP-0002",
          firstName: "C",
          lastName: "D",
          email: "c@x.com",
          country: "GB",
          department: "Eng",
          jobTitle: "Eng",
          level: "L1",
          hireDate: "2024-01-01",
        },
      ])
      .returning();
    await db.insert(salaryRecords).values(
      empRows.map((e) => ({
        organizationId: org.id,
        employeeId: e.id,
        amount: "50000.00",
        currency: "USD",
        effectiveDate: "2024-01-01",
        reason: "hire",
        createdBy: "viewer_1",
      })),
    );

    const res = await employeesRoutes.fetch(
      new Request("http://test/employees/export?country=US", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("EMP-0001");
    expect(text).not.toContain("EMP-0002"); // filtered out by country=US
    expect(text).toContain("50000.00");
  });
});
