import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, auditLog } from "./schema.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

describe("schema", () => {
  it("persists an organization and its membership", async () => {
    const orgs = await db.insert(organizations).values({ name: "ACME Corp", slug: "acme" }).returning();
    const org = orgs[0];
    if (!org) throw new Error("Failed to create organization");

    await db.insert(memberships).values({
      organizationId: org.id,
      clerkUserId: "user_1",
      role: "admin",
      status: "active",
    });

    const rows = await db.select().from(memberships).where(eq(memberships.organizationId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("admin");
  });
});

describe("salary-domain schema", () => {
  it("persists an employee with a salary record and an audit log entry", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-schema-test" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");

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
        hireDate: "2024-01-15",
      })
      .returning();
    const employee = empRows[0];
    if (!employee) throw new Error("insert did not return a row");

    await db.insert(salaryRecords).values({
      organizationId: org.id,
      employeeId: employee.id,
      amount: "85000.00",
      currency: "GBP",
      effectiveDate: "2024-01-15",
      reason: "hire",
      createdBy: "user_1",
    });

    await db.insert(auditLog).values({
      organizationId: org.id,
      actorClerkUserId: "user_1",
      action: "create",
      entityType: "employee",
      entityId: employee.id,
      before: null,
      after: { employeeNumber: "EMP-0001" },
    });

    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.employeeId, employee.id));
    expect(salaries).toHaveLength(1);
    expect(salaries[0]?.amount).toBe("85000.00");

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, employee.id));
    expect(audits).toHaveLength(1);
  });

  it("rejects a duplicate employee number within one organization", async () => {
    const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-dup-test" }).returning();
    const org = orgRows[0];
    if (!org) throw new Error("insert did not return a row");

    const values = {
      organizationId: org.id,
      employeeNumber: "EMP-0001",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      country: "GB",
      department: "Engineering",
      jobTitle: "Analyst",
      level: "L3",
      hireDate: "2024-01-15",
    };
    await db.insert(employees).values(values);
    await expect(db.insert(employees).values(values)).rejects.toThrow();
  });
});
