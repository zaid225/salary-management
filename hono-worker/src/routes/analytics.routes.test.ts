import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, fxRates } from "../models/schema.js";
import { analyticsRoutes } from "./analytics.routes.js";

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

describe("GET /analytics/summary", () => {
  it("computes headcount/avg/median/total in USD, normalized across currencies", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-analytics" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });
    await db.insert(fxRates).values([
      { currency: "USD", rateToUsd: "1.000000", asOfDate: "2024-01-01" },
      { currency: "EUR", rateToUsd: "1.100000", asOfDate: "2024-01-01" },
    ]);

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
          country: "US",
          department: "Sales",
          jobTitle: "Rep",
          level: "L1",
          hireDate: "2024-01-01",
        },
      ])
      .returning();
    await db.insert(salaryRecords).values([
      {
        organizationId: org.id,
        employeeId: empRows[0]!.id,
        amount: "100000.00",
        currency: "USD",
        effectiveDate: "2024-01-01",
        reason: "hire",
        createdBy: "viewer_1",
      },
      {
        organizationId: org.id,
        employeeId: empRows[1]!.id,
        amount: "100000.00",
        currency: "EUR",
        effectiveDate: "2024-01-01",
        reason: "hire",
        createdBy: "viewer_1",
      },
    ]);

    const res = await analyticsRoutes.fetch(
      new Request("http://test/analytics/summary", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      headcount: number;
      totalCostUsd: number;
      medianUsd: number;
      byDepartment: { department: string; headcount: number }[];
      byCountry: { country: string; headcount: number }[];
    };
    expect(body.headcount).toBe(2);
    expect(body.totalCostUsd).toBeCloseTo(100000 + 100000 * 1.1, 0);
    expect(body.medianUsd).toBeCloseTo(105000, 0);
    expect(body.byDepartment.find((d) => d.department === "Sales")?.headcount).toBe(1);
    expect(body.byCountry.find((d) => d.country === "US")?.headcount).toBe(2);
  });

  it("excludes an employee whose currency has no fx rate rather than erroring", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-analytics3" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    await db
      .insert(memberships)
      .values({ organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" });

    const empRows = await db
      .insert(employees)
      .values({
        organizationId: org.id,
        employeeNumber: "EMP-0001",
        firstName: "A",
        lastName: "B",
        email: "a@x.com",
        country: "GB",
        department: "Eng",
        jobTitle: "Eng",
        level: "L1",
        hireDate: "2024-01-01",
      })
      .returning();
    await db.insert(salaryRecords).values({
      organizationId: org.id,
      employeeId: empRows[0]!.id,
      amount: "80000.00",
      currency: "GBP", // no fx_rates row seeded
      effectiveDate: "2024-01-01",
      reason: "hire",
      createdBy: "viewer_1",
    });

    const res = await analyticsRoutes.fetch(
      new Request("http://test/analytics/summary", { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { headcount: number };
    expect(body.headcount).toBe(0);
  });

  it("403s a non-member", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-analytics2" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");
    const res = await analyticsRoutes.fetch(
      new Request("http://test/analytics/summary", { headers: authed("stranger", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });
});
