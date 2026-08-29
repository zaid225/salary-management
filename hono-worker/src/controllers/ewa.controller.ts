import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import type { Db } from "../models/db.js";
import { ewaRequests, ledgerEvents, ledgerBalances } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { computeAccrual, computeMaxAdvance } from "../lib/payroll-engine.js";
import type { RequestEwaBody, ReviewEwaRequestBody } from "../schemas/payroll.schema.js";

type RequestIn = {
  in: { json: z.input<typeof RequestEwaBody> };
  out: { json: z.infer<typeof RequestEwaBody> };
};

/**
 * Creates an EWA request. The accrual and max-advance figures are computed
 * fresh right here (lib/payroll-engine.ts, pure, no AI) and snapshotted onto
 * the row - so the record of *why* a request was allowed or capped survives
 * even if the employee's salary changes later.
 *
 * No employee self-service login exists in this app (see design spec §1's
 * scope note), so this - like every other mutating route here - is an admin
 * action taken on an employee's behalf, not the employee's own request.
 */
export async function requestEwaAdvance(c: Context<AppBindings, string, RequestIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { employeeId, requestedMinor, periodStart, periodEnd } = c.req.valid("json");

  const scoped = scopedDb(db, orgId);
  const employee = await scoped.employees.getById(employeeId);
  if (!employee) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const currentSalary = (await scoped.salaryRecords.currentFor([employeeId])).get(employeeId);
  if (!currentSalary) {
    return c.json(
      { error: { message: "Employee has no salary on record to accrue against", statusCode: 400 } },
      400,
    );
  }

  const asOfDate = new Date().toISOString().slice(0, 10);
  const accrual = computeAccrual({
    annualSalaryMinor: Math.round(Number(currentSalary.amount) * 100),
    periodStart,
    periodEnd,
    asOfDate,
  });

  const alreadyAdvanced = await sumApprovedAdvances(db, orgId, employeeId, periodStart, periodEnd);
  const maxAllowedMinor = computeMaxAdvance(accrual.accruedGrossMinor, alreadyAdvanced);

  if (requestedMinor > maxAllowedMinor) {
    return c.json(
      {
        error: {
          message: `Requested amount exceeds the allowed advance (max ${maxAllowedMinor} minor units, accrued ${accrual.accruedGrossMinor})`,
          statusCode: 422,
        },
      },
      422,
    );
  }

  const [request] = await db
    .insert(ewaRequests)
    .values({
      organizationId: orgId,
      employeeId,
      requestedMinor,
      periodStart,
      periodEnd,
      accruedAtRequestMinor: accrual.accruedGrossMinor,
      maxAllowedAtRequestMinor: maxAllowedMinor,
      currency: currentSalary.currency,
      status: "pending",
      requestedBy: userId,
    })
    .returning();
  if (!request) throw new Error("ewa request insert did not return a row");

  return c.json({ request }, 201);
}

async function sumApprovedAdvances(
  db: Db,
  orgId: string,
  employeeId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  // Only advances already approved *against this exact declared period*
  // count against the cap - matched on the request's own stored period,
  // not on when it happened to be created.
  const rows = await db
    .select()
    .from(ewaRequests)
    .where(
      and(
        eq(ewaRequests.organizationId, orgId),
        eq(ewaRequests.employeeId, employeeId),
        eq(ewaRequests.status, "approved"),
        eq(ewaRequests.periodStart, periodStart),
        eq(ewaRequests.periodEnd, periodEnd),
      ),
    );
  return rows.reduce((sum, r) => sum + r.requestedMinor, 0);
}

/**
 * The only route that writes ledgerEvents/ledgerBalances for an EWA
 * request. Rejecting a request writes nothing to the ledger at all - the
 * ledger only ever records money that actually moved.
 */
export async function reviewEwaRequest(c: Context<AppBindings, string, { in: { json: z.input<typeof ReviewEwaRequestBody> }; out: { json: z.infer<typeof ReviewEwaRequestBody> } }>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const requestId = c.req.param("requestId");
  const { decision } = c.req.valid("json");

  if (!requestId) return c.json({ error: { message: "Request not found", statusCode: 404 } }, 404);

  const [existing] = await db
    .select()
    .from(ewaRequests)
    .where(and(eq(ewaRequests.id, requestId), eq(ewaRequests.organizationId, orgId)))
    .limit(1);
  if (!existing) return c.json({ error: { message: "Request not found", statusCode: 404 } }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: { message: "This request has already been reviewed", statusCode: 409 } }, 409);
  }

  if (decision === "rejected") {
    const [updated] = await db
      .update(ewaRequests)
      .set({ status: "rejected", reviewedBy: userId, reviewedAt: new Date() })
      .where(eq(ewaRequests.id, requestId))
      .returning();
    return c.json({ request: updated });
  }

  let ledgerEventId: string | undefined;
  await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(ledgerEvents)
      .values({
        organizationId: orgId,
        eventType: "ewa_advance",
        entityType: "ewa_request",
        entityId: existing.id,
        amountMinor: existing.requestedMinor,
        currency: existing.currency,
        payload: { employeeId: existing.employeeId },
        actorClerkUserId: userId,
      })
      .returning();
    if (!event) throw new Error("ledger event insert did not return a row");
    ledgerEventId = event.id;

    // Double-entry: employer_cash pays out now; ewa_liability records that
    // this amount is owed back at the employee's next actual paycheck
    // (settling that liability against a real payroll run is not
    // implemented in this pass - see plan).
    await tx.insert(ledgerBalances).values([
      {
        organizationId: orgId,
        accountType: "employer_cash",
        accountId: orgId,
        eventId: event.id,
        deltaMinor: -existing.requestedMinor,
        currency: existing.currency,
      },
      {
        organizationId: orgId,
        accountType: "ewa_liability",
        accountId: existing.employeeId,
        eventId: event.id,
        deltaMinor: existing.requestedMinor,
        currency: existing.currency,
      },
    ]);

    await tx
      .update(ewaRequests)
      .set({ status: "approved", reviewedBy: userId, reviewedAt: new Date(), ledgerEventId: event.id })
      .where(eq(ewaRequests.id, requestId));
  });

  const [updated] = await db.select().from(ewaRequests).where(eq(ewaRequests.id, requestId)).limit(1);
  return c.json({ request: updated, ledgerEventId });
}

export async function listEwaRequests(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const rows = await db
    .select()
    .from(ewaRequests)
    .where(eq(ewaRequests.organizationId, orgId))
    .orderBy(desc(ewaRequests.createdAt));
  return c.json({ requests: rows });
}

/**
 * Read-only accrual preview - lets the UI show "up to $X available" before
 * the admin commits to a request amount. Same computeAccrual/computeMaxAdvance
 * call the request handler itself uses, so the preview and the enforced
 * limit can never drift apart.
 */
export async function getEwaAccrual(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const employeeId = c.req.param("employeeId");
  const periodStart = c.req.query("periodStart");
  const periodEnd = c.req.query("periodEnd");
  if (!employeeId || !periodStart || !periodEnd) {
    return c.json(
      { error: { message: "employeeId, periodStart and periodEnd are required", statusCode: 400 } },
      400,
    );
  }

  const scoped = scopedDb(db, orgId);
  const employee = await scoped.employees.getById(employeeId);
  if (!employee) return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);

  const currentSalary = (await scoped.salaryRecords.currentFor([employeeId])).get(employeeId);
  if (!currentSalary) {
    return c.json({ accruedGrossMinor: 0, maxAllowedMinor: 0, currency: null });
  }

  const asOfDate = new Date().toISOString().slice(0, 10);
  const accrual = computeAccrual({
    annualSalaryMinor: Math.round(Number(currentSalary.amount) * 100),
    periodStart,
    periodEnd,
    asOfDate,
  });
  const alreadyAdvanced = await sumApprovedAdvances(db, orgId, employeeId, periodStart, periodEnd);
  const maxAllowedMinor = computeMaxAdvance(accrual.accruedGrossMinor, alreadyAdvanced);

  return c.json({
    accruedGrossMinor: accrual.accruedGrossMinor,
    maxAllowedMinor,
    currency: currentSalary.currency,
  });
}
