import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq, desc } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import {
  payrollRuns,
  payrollRunLines,
  ledgerEvents,
  ledgerBalances,
} from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { computePayrollRun, type PayrollLineInput } from "../lib/payroll-engine.js";
import type { CreatePayrollRunBody } from "../schemas/payroll.schema.js";

type CreateIn = {
  in: { json: z.input<typeof CreatePayrollRunBody> };
  out: { json: z.infer<typeof CreatePayrollRunBody> };
};

export async function createPayrollRun(c: Context<AppBindings, string, CreateIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { periodStart, periodEnd, jurisdiction } = c.req.valid("json");

  if (periodEnd < periodStart) {
    return c.json(
      { error: { message: "periodEnd must not be before periodStart", statusCode: 400 } },
      400,
    );
  }

  const [run] = await db
    .insert(payrollRuns)
    .values({ organizationId: orgId, periodStart, periodEnd, jurisdiction, status: "draft", createdBy: userId })
    .returning();
  if (!run) throw new Error("payroll run insert did not return a row");

  return c.json({ run }, 201);
}

/**
 * Runs the deterministic engine (lib/payroll-engine.ts) over every active
 * employee and replaces this run's lines with the result. Pure computation
 * happens outside the transaction; only the write is transactional. Safe to
 * call repeatedly while the run is still 'draft' - each call is a full,
 * clean recalculation, not an incremental patch.
 */
export async function calculatePayrollRun(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);

  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .limit(1);
  if (!run) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);
  if (run.status === "posted" || run.status === "cancelled") {
    return c.json(
      { error: { message: `Cannot calculate a run that is already ${run.status}`, statusCode: 409 } },
      409,
    );
  }

  const scoped = scopedDb(db, orgId);
  const active = await scoped.employees.list({ limit: 1000, offset: 0 });
  const currentSalaries = await scoped.salaryRecords.currentFor(active.map((e) => e.id));

  const inputs: PayrollLineInput[] = [];
  for (const e of active) {
    const salary = currentSalaries.get(e.id);
    if (!salary) continue; // no salary on record - nothing to run payroll on for this employee
    inputs.push({
      employeeId: e.id,
      annualSalaryMinor: Math.round(Number(salary.amount) * 100),
      currency: salary.currency,
      jurisdiction: run.jurisdiction,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
    });
  }

  const results = computePayrollRun(inputs);

  let totalGrossMinor = 0;
  let totalNetMinor = 0;
  for (const r of results) {
    if (r.supported) {
      totalGrossMinor += r.grossMinor;
      totalNetMinor += r.netMinor;
    }
  }

  await db.transaction(async (tx) => {
    // Clean slate: a recalculation is a fresh computation, not a patch.
    await tx.delete(payrollRunLines).where(eq(payrollRunLines.payrollRunId, runId));

    if (results.length > 0) {
      await tx.insert(payrollRunLines).values(
        results.map((r) =>
          r.supported
            ? {
                payrollRunId: runId,
                employeeId: r.employeeId,
                jurisdiction: run.jurisdiction,
                supported: "true",
                grossMinor: r.grossMinor,
                netMinor: r.netMinor,
                currency: r.currency,
                deductions: r.deductions,
                unsupportedReason: null,
              }
            : {
                payrollRunId: runId,
                employeeId: r.employeeId,
                jurisdiction: run.jurisdiction,
                supported: "false",
                grossMinor: null,
                netMinor: null,
                currency: null,
                deductions: null,
                unsupportedReason: r.reason,
              },
        ),
      );
    }

    await tx
      .update(payrollRuns)
      .set({ status: "calculated", totalGrossMinor, totalNetMinor, calculatedAt: new Date() })
      .where(eq(payrollRuns.id, runId));
  });

  const [updated] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  return c.json({ run: updated, lineCount: results.length });
}

/**
 * The only route that ever writes to ledgerEvents/ledgerBalances for a
 * payroll run. Requires 'calculated' status and can only ever run once per
 * run (status flips to 'posted', and this handler checks for that before
 * doing anything) - a paycheck is never issued twice for the same run.
 */
export async function postPayrollRun(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);

  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .limit(1);
  if (!run) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);
  if (run.status !== "calculated") {
    return c.json(
      { error: { message: `Only a calculated run can be posted (this one is ${run.status})`, statusCode: 409 } },
      409,
    );
  }

  const lines = (
    await db
      .select()
      .from(payrollRunLines)
      .where(and(eq(payrollRunLines.payrollRunId, runId), eq(payrollRunLines.supported, "true")))
  ).filter((l) => l.grossMinor !== null && l.netMinor !== null && l.currency !== null) as (typeof payrollRunLines.$inferSelect & {
    grossMinor: number;
    netMinor: number;
    currency: string;
  })[];

  await db.transaction(async (tx) => {
    if (lines.length > 0) {
      // Batched, not looped: one INSERT...RETURNING for every ledger event
      // and one for every balance leg, instead of 2 round trips per
      // employee serialized inside this transaction - with enough
      // employees the old per-line loop was slow enough to blow past the
      // request timeout (same class of bug as the pre-flight auditor's
      // per-row PII-token loop, fixed the same way). A single multi-row
      // INSERT...RETURNING preserves VALUES order, so zipping the returned
      // events back to `lines` by index is safe here.
      const events = await tx
        .insert(ledgerEvents)
        .values(
          lines.map((line) => ({
            organizationId: orgId,
            eventType: "paycheck_issued" as const,
            entityType: "payroll_run" as const,
            entityId: run.id,
            amountMinor: line.netMinor,
            currency: line.currency,
            payload: { employeeId: line.employeeId, grossMinor: line.grossMinor, deductions: line.deductions },
            actorClerkUserId: userId,
          })),
        )
        .returning();
      if (events.length !== lines.length) throw new Error("ledger event batch insert returned an unexpected row count");

      // Double-entry: employer_cash debits by gross, employee_gross credits
      // by net (what actually reaches the employee) and tax_payable credits
      // by the withheld difference - the three legs sum to zero, per event.
      const balances = lines.flatMap((line, i) => {
        const event = events[i]!;
        const withheldMinor = line.grossMinor - line.netMinor;
        return [
          {
            organizationId: orgId,
            accountType: "employer_cash" as const,
            accountId: orgId,
            eventId: event.id,
            deltaMinor: -line.grossMinor,
            currency: line.currency,
          },
          {
            organizationId: orgId,
            accountType: "employee_gross" as const,
            accountId: line.employeeId,
            eventId: event.id,
            deltaMinor: line.netMinor,
            currency: line.currency,
          },
          {
            organizationId: orgId,
            accountType: "tax_payable" as const,
            accountId: orgId,
            eventId: event.id,
            deltaMinor: withheldMinor,
            currency: line.currency,
          },
        ];
      });
      await tx.insert(ledgerBalances).values(balances);
    }

    await tx.update(payrollRuns).set({ status: "posted", postedAt: new Date() }).where(eq(payrollRuns.id, runId));
  });

  const [updated] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  return c.json({ run: updated, paychecksIssued: lines.length });
}

export async function getPayrollRun(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const runId = c.req.param("runId");
  if (!runId) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);

  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .limit(1);
  if (!run) return c.json({ error: { message: "Payroll run not found", statusCode: 404 } }, 404);

  const lines = await db.select().from(payrollRunLines).where(eq(payrollRunLines.payrollRunId, runId));
  return c.json({ run, lines });
}

export async function listPayrollRuns(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const runs = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.organizationId, orgId))
    .orderBy(desc(payrollRuns.createdAt));
  return c.json({ runs });
}
