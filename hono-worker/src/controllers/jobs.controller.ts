import type { Context } from "hono";
import type { z } from "zod/v4";
import { eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { jobs } from "../models/schema.js";
import {
  advanceBulkDelete,
  appendJobLog,
  countBulkDeleteTargets,
  getJobWithLogs,
  listJobs,
  newRunToken,
  type BulkDeleteParams,
} from "../models/jobs.js";
import type { BulkDeleteBody } from "../schemas/job.schema.js";
import type { PaginationQuery } from "../schemas/pagination.schema.js";

type CreateIn = {
  in: { json: z.input<typeof BulkDeleteBody> };
  out: { json: z.infer<typeof BulkDeleteBody> };
};

/**
 * Starts a bulk termination. Returns immediately with a job the caller can
 * watch; the work itself happens through repeated calls to the runner, so no
 * single request has to outlive a Worker's limits.
 */
export async function createBulkDeleteJob(c: Context<AppBindings, string, CreateIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const body = c.req.valid("json");

  const params: BulkDeleteParams = {
    employeeIds: body.employeeIds ?? null,
    ...(body.country ? { country: body.country } : {}),
    ...(body.department ? { department: body.department } : {}),
  };

  const total = await countBulkDeleteTargets(db, orgId, params);
  if (total === 0) {
    return c.json(
      { error: { message: "Nothing to delete - no active employees match this selection", statusCode: 400 } },
      400,
    );
  }

  const [job] = await db
    .insert(jobs)
    .values({
      organizationId: orgId,
      type: "bulk_delete_employees",
      status: "queued",
      total,
      params,
      runToken: newRunToken(),
      createdBy: userId,
    })
    .returning();
  if (!job) throw new Error("job insert did not return a row");

  await appendJobLog(db, job.id, "info", `Queued termination of ${total} employees.`);

  // 202, not 201: the resource exists but the work it describes has not
  // happened yet.
  return c.json({ job: redactRunToken(job) }, 202);
}

/**
 * Processes the next chunk. Deliberately callable two ways:
 *  - by an admin in the browser (session-authenticated), which is what drives
 *    a job while someone is watching it;
 *  - by an unattended runner presenting the job's run token, which is how a
 *    queue callback would drive it with no user session.
 * Either way the progress lives in the row, so a closed tab loses nothing.
 */
export async function advanceJob(c: Context<AppBindings>): Promise<Response> {
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);

  const sessionDb = c.get("db");
  const runToken = c.req.header("X-Job-Run-Token");

  // Session path: resolveOrg already proved membership and admin role.
  if (sessionDb) {
    const orgId = c.get("orgId")!;
    const found = await getJobWithLogs(sessionDb, orgId, jobId);
    if (!found) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);
    const result = await advanceBulkDelete(sessionDb, jobId);
    return c.json({ done: result.done, processedNow: result.processedNow, job: redactRunToken(result.job) });
  }

  // Token path: no session, so the token is the only authority. It is
  // compared against the row rather than a shared secret, so a leaked token
  // can only ever advance the one job it belongs to.
  if (!runToken) {
    return c.json({ error: { message: "Unauthorized", statusCode: 401 } }, 401);
  }
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  try {
    const [job] = await conn.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job || !timingSafeEqual(job.runToken, runToken)) {
      return c.json({ error: { message: "Unauthorized", statusCode: 401 } }, 401);
    }
    const result = await advanceBulkDelete(conn.db, jobId);
    return c.json({ done: result.done, processedNow: result.processedNow, job: redactRunToken(result.job) });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function cancelJob(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);

  const found = await getJobWithLogs(db, orgId, jobId);
  if (!found) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);
  if (found.job.status === "succeeded") {
    return c.json({ error: { message: "This job has already finished", statusCode: 409 } }, 409);
  }

  // Cancelling stops further chunks; it does not resurrect employees already
  // terminated, and the log says so rather than implying a rollback.
  await db
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
  await appendJobLog(
    db,
    jobId,
    "warn",
    `Cancelled after ${found.job.processed} of ${found.job.total}. Already-terminated employees stay terminated.`,
  );

  return c.json({ ok: true });
}

export async function getJob(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);

  const found = await getJobWithLogs(db, orgId, jobId);
  if (!found) return c.json({ error: { message: "Job not found", statusCode: 404 } }, 404);

  return c.json({ job: redactRunToken(found.job), logs: found.logs });
}

type ListIn = {
  in: { query: z.input<typeof PaginationQuery> };
  out: { query: z.infer<typeof PaginationQuery> };
};

export async function listOrgJobs(c: Context<AppBindings, string, ListIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const { limit, offset } = c.req.valid("query");

  const rows = await listJobs(db, orgId, limit, offset);
  return c.json({ jobs: rows.map(redactRunToken), limit, offset });
}

// The run token is a credential for driving the job - it must never reach a
// client that only needs to watch one.
function redactRunToken(job: typeof jobs.$inferSelect) {
  const { runToken: _runToken, ...rest } = job;
  return rest;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
