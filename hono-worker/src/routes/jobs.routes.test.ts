import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, employees, salaryRecords, auditLog, jobs } from "../models/schema.js";
import { jobsRoutes } from "./jobs.routes.js";

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

async function seedOrgWithEmployees(count: number, slug = "acme-jobs") {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug }).returning();
  const org = orgRows[0];
  if (!org) throw new Error("insert did not return a row");
  await db.insert(memberships).values([
    { organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" },
    { organizationId: org.id, clerkUserId: "viewer_1", role: "viewer", status: "active" },
  ]);

  const inserted = await db
    .insert(employees)
    .values(
      Array.from({ length: count }, (_, i) => ({
        organizationId: org.id,
        employeeNumber: `EMP-${String(i + 1).padStart(6, "0")}`,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        email: `user${i}@example.com`,
        country: i % 2 === 0 ? "US" : "GB",
        department: i % 2 === 0 ? "Engineering" : "Sales",
        jobTitle: "Engineer",
        level: "L3",
        hireDate: "2024-01-01",
      })),
    )
    .returning();

  await db.insert(salaryRecords).values(
    inserted.map((e) => ({
      organizationId: org.id,
      employeeId: e.id,
      amount: "50000.00",
      currency: "USD",
      effectiveDate: "2024-01-01",
      reason: "hire",
      createdBy: "admin_1",
    })),
  );

  return { org, inserted };
}

function post(path: string, orgId: string, user = "admin_1", body?: unknown) {
  return jobsRoutes.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: authed(user, orgId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv(),
    testExecutionCtx(),
  );
}

describe("POST /employees/bulk-delete", () => {
  it("returns 202 with a queued job rather than doing the work inline", async () => {
    const { org } = await seedOrgWithEmployees(5);
    const res = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { id: string; status: string; total: number } };
    expect(body.job.status).toBe("queued");
    expect(body.job.total).toBe(3); // indices 0, 2, 4

    // Nothing terminated yet - queuing is not doing.
    const stillActive = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    expect(stillActive.every((e) => e.employmentStatus === "active")).toBe(true);
  });

  it("never leaks the run token to a client", async () => {
    const { org } = await seedOrgWithEmployees(2);
    const res = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const text = await res.text();
    expect(text).not.toContain("runToken");

    const [row] = await db.select().from(jobs).where(eq(jobs.organizationId, org.id));
    expect(row?.runToken).toBeTruthy();
    expect(text).not.toContain(row!.runToken);
  });

  it("403s a viewer", async () => {
    const { org } = await seedOrgWithEmployees(2);
    const res = await post("/employees/bulk-delete", org.id, "viewer_1", { department: "Engineering" });
    expect(res.status).toBe(403);
  });

  it("400s a request that would match the entire roster by accident", async () => {
    const { org } = await seedOrgWithEmployees(2);
    const res = await post("/employees/bulk-delete", org.id, "admin_1", {});
    expect(res.status).toBe(400);
  });

  it("400s when nothing matches", async () => {
    const { org } = await seedOrgWithEmployees(2);
    const res = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Nonexistent" });
    expect(res.status).toBe(400);
  });
});

describe("job progress", () => {
  it("advances in chunks, survives being resumed, and is audited", async () => {
    const { org } = await seedOrgWithEmployees(6);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string; total: number } };

    // One advance clears the whole (small) batch, then a second reports done -
    // the same shape a 10,000-row job goes through, just fewer rounds.
    const first = await post(`/jobs/${job.id}/advance`, org.id);
    const firstBody = (await first.json()) as { done: boolean; job: { processed: number; status: string } };
    expect(firstBody.job.processed).toBe(3);
    expect(firstBody.job.status).toBe("running");

    const second = await post(`/jobs/${job.id}/advance`, org.id);
    const secondBody = (await second.json()) as { done: boolean; job: { status: string } };
    expect(secondBody.done).toBe(true);
    expect(secondBody.job.status).toBe("succeeded");

    const rows = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    const terminated = rows.filter((e) => e.employmentStatus === "terminated");
    expect(terminated).toHaveLength(3);
    expect(terminated.every((e) => e.department === "Engineering")).toBe(true);

    // Soft delete: salary history is untouched.
    const salaries = await db.select().from(salaryRecords).where(eq(salaryRecords.organizationId, org.id));
    expect(salaries).toHaveLength(6);

    // Every termination is on the audit trail, same as a single delete.
    const audits = await db.select().from(auditLog).where(eq(auditLog.organizationId, org.id));
    expect(audits.filter((a) => a.action === "delete")).toHaveLength(3);
  });

  it("is safe to advance again after it has finished", async () => {
    const { org } = await seedOrgWithEmployees(4);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };

    await post(`/jobs/${job.id}/advance`, org.id);
    await post(`/jobs/${job.id}/advance`, org.id);
    // A retry after completion must not double-count or resurrect anything.
    const extra = await post(`/jobs/${job.id}/advance`, org.id);
    const body = (await extra.json()) as { done: boolean; processedNow: number; job: { succeeded: number } };
    expect(body.done).toBe(true);
    expect(body.processedNow).toBe(0);
    expect(body.job.succeeded).toBe(2);
  });

  it("keeps progress readable after the client goes away", async () => {
    const { org } = await seedOrgWithEmployees(6);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };
    await post(`/jobs/${job.id}/advance`, org.id);

    // Simulates coming back in a fresh tab: the row is the source of truth.
    const res = await jobsRoutes.fetch(
      new Request(`http://test/jobs/${job.id}`, { headers: authed("viewer_1", org.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job: { processed: number; total: number };
      logs: { message: string }[];
    };
    expect(body.job.processed).toBe(3);
    expect(body.logs.length).toBeGreaterThan(0);
  });

  it("cancelling stops further work without resurrecting what already ran", async () => {
    const { org } = await seedOrgWithEmployees(6);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };
    await post(`/jobs/${job.id}/advance`, org.id);

    const cancelled = await post(`/jobs/${job.id}/cancel`, org.id);
    expect(cancelled.status).toBe(200);

    const after = await post(`/jobs/${job.id}/advance`, org.id);
    const body = (await after.json()) as { done: boolean; processedNow: number };
    expect(body.done).toBe(true);
    expect(body.processedNow).toBe(0);

    const rows = await db.select().from(employees).where(eq(employees.organizationId, org.id));
    expect(rows.filter((e) => e.employmentStatus === "terminated")).toHaveLength(3);
  });

  it("does not expose another org's job", async () => {
    const { org } = await seedOrgWithEmployees(4);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };

    const otherRows = await db.insert(organizations).values({ name: "Other", slug: "other-jobs" }).returning();
    const other = otherRows[0]!;
    await db
      .insert(memberships)
      .values({ organizationId: other.id, clerkUserId: "admin_2", role: "admin", status: "active" });

    const res = await jobsRoutes.fetch(
      new Request(`http://test/jobs/${job.id}`, { headers: authed("admin_2", other.id) }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /jobs/:jobId/run (unattended runner)", () => {
  it("401s without the run token", async () => {
    const { org } = await seedOrgWithEmployees(4);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };

    const res = await jobsRoutes.fetch(
      new Request(`http://test/jobs/${job.id}/run`, { method: "POST" }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("401s with the wrong run token", async () => {
    const { org } = await seedOrgWithEmployees(4);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };

    const res = await jobsRoutes.fetch(
      new Request(`http://test/jobs/${job.id}/run`, {
        method: "POST",
        headers: { "X-Job-Run-Token": "x".repeat(64) },
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("runs the job when presented with its own token", async () => {
    const { org } = await seedOrgWithEmployees(4);
    const created = await post("/employees/bulk-delete", org.id, "admin_1", { department: "Engineering" });
    const { job } = (await created.json()) as { job: { id: string } };

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    const res = await jobsRoutes.fetch(
      new Request(`http://test/jobs/${job.id}/run`, {
        method: "POST",
        headers: { "X-Job-Run-Token": row!.runToken },
      }),
      testEnv(),
      testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { processed: number } };
    expect(body.job.processed).toBe(2);
  });
});
