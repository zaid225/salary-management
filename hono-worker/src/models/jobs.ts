import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { employees, jobLogs, jobs } from "./schema.js";
import { writeAuditMany } from "./audit.js";

// How many employees one call to the runner handles. Small enough to finish
// well inside a Worker's limits even on a slow connection, large enough that
// 10,000 rows is ~20 calls rather than 10,000.
export const JOB_CHUNK_SIZE = 500;

export interface BulkDeleteParams {
  /** Explicit ids to terminate, or null to mean "everything matching filters". */
  employeeIds: string[] | null;
  country?: string;
  department?: string;
  search?: string;
}

export function newRunToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function appendJobLog(
  db: Db,
  jobId: string,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  await db.insert(jobLogs).values({ jobId, level, message });
}

function targetConditions(orgId: string, params: BulkDeleteParams) {
  const conditions = [
    eq(employees.organizationId, orgId),
    // Only active employees are candidates; terminating an already-terminated
    // employee is a no-op, and counting them would overstate the total.
    eq(employees.employmentStatus, "active"),
  ];
  if (params.employeeIds && params.employeeIds.length > 0) {
    conditions.push(inArray(employees.id, params.employeeIds));
  }
  if (params.country) conditions.push(eq(employees.country, params.country));
  if (params.department) conditions.push(eq(employees.department, params.department));
  return conditions;
}

export async function countBulkDeleteTargets(
  db: Db,
  orgId: string,
  params: BulkDeleteParams,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(employees)
    .where(and(...targetConditions(orgId, params)));
  return row?.count ?? 0;
}

export interface AdvanceResult {
  done: boolean;
  processedNow: number;
  job: typeof jobs.$inferSelect;
}

/**
 * Terminates one chunk of the job's targets and records progress.
 *
 * Safe to call again after a crash or a retry: it walks forward by id from
 * the stored cursor and only ever touches rows that are still active, so a
 * repeated call re-does at most one chunk and never double-counts a row it
 * already terminated.
 */
export async function advanceBulkDelete(db: Db, jobId: string): Promise<AdvanceResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error("job not found");
  if (job.status === "succeeded" || job.status === "cancelled") {
    return { done: true, processedNow: 0, job };
  }

  const params = (job.params ?? { employeeIds: null }) as BulkDeleteParams;
  const conditions = targetConditions(job.organizationId, params);
  if (job.cursor) conditions.push(gt(employees.id, job.cursor));

  const batch = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(...conditions))
    .orderBy(asc(employees.id))
    .limit(JOB_CHUNK_SIZE);

  if (batch.length === 0) {
    const [finished] = await db
      .update(jobs)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(jobs.id, jobId))
      .returning();
    await appendJobLog(db, jobId, "info", `Finished: ${job.succeeded} employees terminated.`);
    return { done: true, processedNow: 0, job: finished ?? job };
  }

  const ids = batch.map((b) => b.id);
  const lastId = ids[ids.length - 1]!;

  await db.transaction(async (tx) => {
    const before = await tx.select().from(employees).where(inArray(employees.id, ids));

    await tx
      .update(employees)
      .set({ employmentStatus: "terminated", updatedAt: new Date() })
      .where(inArray(employees.id, ids));

    // Same guarantee as a single delete: the audit entries commit with the
    // rows they describe, not after them.
    await writeAuditMany(
      tx,
      before.map((e) => ({
        organizationId: job.organizationId,
        actorClerkUserId: job.createdBy,
        action: "delete" as const,
        entityType: "employee" as const,
        entityId: e.id,
        before: e,
        after: { ...e, employmentStatus: "terminated" },
      })),
    );

    await tx
      .update(jobs)
      .set({
        status: "running",
        processed: job.processed + ids.length,
        succeeded: job.succeeded + ids.length,
        cursor: lastId,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  });

  await appendJobLog(db, jobId, "info", `Terminated ${ids.length} employees (${job.processed + ids.length}/${job.total}).`);

  const [updated] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return { done: false, processedNow: ids.length, job: updated ?? job };
}

export async function listJobs(db: Db, orgId: string, limit: number, offset: number) {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.organizationId, orgId))
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function getJobWithLogs(db: Db, orgId: string, jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, orgId)))
    .limit(1);
  if (!job) return null;

  const logs = await db
    .select()
    .from(jobLogs)
    .where(eq(jobLogs.jobId, jobId))
    .orderBy(desc(jobLogs.createdAt))
    .limit(50);

  return { job, logs };
}
