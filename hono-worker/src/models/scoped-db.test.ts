import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, invitations, employees, salaryRecords } from "./schema.js";
import { scopedDb } from "./scoped-db.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

async function seedTwoOrgs() {
  const orgsA = await db.insert(organizations).values({ name: "Org A", slug: "org-a" }).returning();
  const orgA = orgsA[0];
  if (!orgA) throw new Error("Failed to create organization A");
  const orgsB = await db.insert(organizations).values({ name: "Org B", slug: "org-b" }).returning();
  const orgB = orgsB[0];
  if (!orgB) throw new Error("Failed to create organization B");

  await db.insert(memberships).values([
    { organizationId: orgA.id, clerkUserId: "user_a1", role: "admin", status: "active" },
    { organizationId: orgA.id, clerkUserId: "user_a2", role: "viewer", status: "active" },
    { organizationId: orgB.id, clerkUserId: "user_b1", role: "admin", status: "active" },
  ]);

  await db.insert(invitations).values([
    {
      organizationId: orgA.id,
      email: "pending@a.com",
      role: "viewer",
      token: "token-a-1",
      status: "pending",
      invitedBy: "user_a1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      organizationId: orgB.id,
      email: "pending@b.com",
      role: "viewer",
      token: "token-b-1",
      status: "pending",
      invitedBy: "user_b1",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ]);

  return { orgA, orgB };
}

describe("scopedDb", () => {
  it("never returns another organization's memberships or invitations", async () => {
    const { orgA, orgB } = await seedTwoOrgs();

    const scopedA = scopedDb(db, orgA.id);
    const membersA = await scopedA.memberships.listActive();
    expect(membersA).toHaveLength(2);
    expect(membersA.every((m) => m.organizationId === orgA.id)).toBe(true);

    const invitesA = await scopedA.invitations.listPending();
    expect(invitesA).toHaveLength(1);
    const inviteA = invitesA[0];
    if (!inviteA) throw new Error("Expected a pending invitation");
    expect(inviteA.organizationId).toBe(orgA.id);

    const scopedB = scopedDb(db, orgB.id);
    expect(await scopedB.memberships.listActive()).toHaveLength(1);
  });

  it("counts only active admins within the given organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    expect(await scopedA.memberships.countActiveAdmins()).toBe(1);
  });

  it("finds a pending invitation by email, scoped to the organization", async () => {
    const { orgA } = await seedTwoOrgs();
    const scopedA = scopedDb(db, orgA.id);
    const found = await scopedA.invitations.findPendingByEmail("pending@a.com");
    expect(found?.email).toBe("pending@a.com");
    expect(await scopedA.invitations.findPendingByEmail("pending@b.com")).toBeNull();
  });
});

async function seedEmployeeWithSalary(
  orgId: string,
  employeeNumber: string,
  amount: string,
  currency: string,
  effectiveDate: string,
) {
  const rows = await db
    .insert(employees)
    .values({
      organizationId: orgId,
      employeeNumber,
      firstName: "Test",
      lastName: "Employee",
      email: `${employeeNumber}@example.com`,
      country: "US",
      department: "Engineering",
      jobTitle: "Engineer",
      level: "L3",
      hireDate: "2023-01-01",
    })
    .returning();
  const employee = rows[0];
  if (!employee) throw new Error("insert did not return a row");
  await db.insert(salaryRecords).values({
    organizationId: orgId,
    employeeId: employee.id,
    amount,
    currency,
    effectiveDate,
    reason: "hire",
    createdBy: "user_1",
  });
  return employee;
}

describe("scopedDb employees/salaryRecords", () => {
  it("lists only active employees within the organization", async () => {
    const { orgA, orgB } = await seedTwoOrgs();
    await seedEmployeeWithSalary(orgA.id, "EMP-0001", "80000.00", "USD", "2024-01-01");
    await seedEmployeeWithSalary(orgB.id, "EMP-0002", "70000.00", "USD", "2024-01-01");

    const listA = await scopedDb(db, orgA.id).employees.list({ limit: 25, offset: 0 });
    expect(listA).toHaveLength(1);
    expect(listA[0]?.employeeNumber).toBe("EMP-0001");
  });

  it("returns only the latest salary record as the current one", async () => {
    const { orgA } = await seedTwoOrgs();
    const employee = await seedEmployeeWithSalary(orgA.id, "EMP-0003", "80000.00", "USD", "2023-01-01");
    await db.insert(salaryRecords).values({
      organizationId: orgA.id,
      employeeId: employee.id,
      amount: "90000.00",
      currency: "USD",
      effectiveDate: "2024-06-01",
      reason: "raise",
      createdBy: "user_1",
    });

    const current = await scopedDb(db, orgA.id).salaryRecords.currentFor([employee.id]);
    expect(current.get(employee.id)?.amount).toBe("90000.00");
  });

  it("returns full salary history for an employee, newest first", async () => {
    const { orgA } = await seedTwoOrgs();
    const employee = await seedEmployeeWithSalary(orgA.id, "EMP-0004", "80000.00", "USD", "2023-01-01");
    await db.insert(salaryRecords).values({
      organizationId: orgA.id,
      employeeId: employee.id,
      amount: "90000.00",
      currency: "USD",
      effectiveDate: "2024-06-01",
      reason: "raise",
      createdBy: "user_1",
    });

    const history = await scopedDb(db, orgA.id).salaryRecords.historyFor(employee.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.amount).toBe("90000.00"); // newest first
  });

  it("never returns another organization's employee by id", async () => {
    const { orgA, orgB } = await seedTwoOrgs();
    const employeeA = await seedEmployeeWithSalary(orgA.id, "EMP-0005", "80000.00", "USD", "2024-01-01");
    expect(await scopedDb(db, orgB.id).employees.getById(employeeA.id)).toBeNull();
  });
});
