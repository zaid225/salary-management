import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, timeEntries } from "../models/schema.js";
import { hrisRoutes } from "./hris.routes.js";

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

async function seedOrgWithEmployee() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-hris" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  const emp = await db
    .insert(employees)
    .values({
      organizationId: org.id,
      employeeNumber: "EMP-0001",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      country: "US",
      department: "Engineering",
      jobTitle: "Engineer",
      level: "L4",
      hireDate: "2024-01-01",
    })
    .returning();
  return { org, employee: emp[0]! };
}

function postWebhook(orgId: string, body: unknown, secretHeader?: string, env = testEnv()) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secretHeader !== undefined) headers["x-hris-secret"] = secretHeader;
  return hrisRoutes.fetch(
    new Request(`http://test/hris/webhook/${orgId}`, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
    testExecutionCtx(),
  );
}

describe("POST /hris/webhook/:orgId", () => {
  it("501s when HRIS_WEBHOOK_SECRET is unset", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await postWebhook(
      org.id,
      { source: "test-hris", punches: [{ employeeId: employee.id, type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z", externalId: "p1" }] },
      "any-secret",
    );
    expect(res.status).toBe(501);
  });

  it("401s a mismatched secret", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const res = await postWebhook(
      org.id,
      { source: "test-hris", punches: [{ employeeId: employee.id, type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z", externalId: "p1" }] },
      "wrong-secret",
      testEnv({ HRIS_WEBHOOK_SECRET: "correct-secret" }),
    );
    expect(res.status).toBe(401);
  });

  it("ingests punches and never duplicates a retried delivery (idempotent replay)", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const env = testEnv({ HRIS_WEBHOOK_SECRET: "correct-secret" });
    const body = {
      source: "test-hris",
      punches: [
        { employeeId: employee.id, type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z", externalId: "punch-1" },
        { employeeId: employee.id, type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z", externalId: "punch-2" },
      ],
    };

    const first = await postWebhook(org.id, body, "correct-secret", env);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { received: number; inserted: number };
    expect(firstBody.received).toBe(2);
    expect(firstBody.inserted).toBe(2);

    // The exact same delivery retried (e.g. the HRIS's own retry-on-timeout
    // behavior) - must not create duplicate rows.
    const retry = await postWebhook(org.id, body, "correct-secret", env);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { received: number; inserted: number };
    expect(retryBody.inserted).toBe(0); // both already exist, onConflictDoNothing

    const rows = await db.select().from(timeEntries).where(eq(timeEntries.organizationId, org.id));
    expect(rows).toHaveLength(2);
  });
});

describe("GET /hris/attendance/:employeeId", () => {
  it("returns raw entries plus computed hours from paired punches", async () => {
    const { org, employee } = await seedOrgWithEmployee();
    const env = testEnv({ HRIS_WEBHOOK_SECRET: "correct-secret" });
    await postWebhook(
      org.id,
      {
        source: "test-hris",
        punches: [
          { employeeId: employee.id, type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z", externalId: "p1" },
          { employeeId: employee.id, type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z", externalId: "p2" },
        ],
      },
      "correct-secret",
      env,
    );

    const res = await hrisRoutes.fetch(
      new Request(
        `http://test/hris/attendance/${employee.id}?periodStart=2024-06-01&periodEnd=2024-06-30`,
        { headers: authed("admin_1", org.id) },
      ),
      env,
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; attendance: { totalHours: number; shifts: unknown[] } };
    expect(body.entries).toHaveLength(2);
    expect(body.attendance.totalHours).toBe(8);
    expect(body.attendance.shifts).toHaveLength(1);
  });

  it("404s an employee not in this org", async () => {
    const { org } = await seedOrgWithEmployee();
    const res = await hrisRoutes.fetch(
      new Request(
        `http://test/hris/attendance/00000000-0000-0000-0000-000000000000?periodStart=2024-06-01&periodEnd=2024-06-30`,
        { headers: authed("admin_1", org.id) },
      ),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});
