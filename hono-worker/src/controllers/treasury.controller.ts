import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { payrollRuns, ewaRequests } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { computeAccrual, computeMaxAdvance } from "../lib/payroll-engine.js";
import { computeTreasuryForecast } from "../lib/treasury-forecast.js";

// UTC first/last day of the current calendar month, as YYYY-MM-DD - the
// window this forecast treats as "the current accrual period" for EWA
// headroom. Same documented exception as EWA's own asOfDate: reading the
// real clock is unavoidable for "what period are we in right now."
function currentMonthBounds(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return {
    periodStart: `${y}-${pad(m + 1)}-01`,
    periodEnd: `${y}-${pad(m + 1)}-${pad(lastDay)}`,
  };
}

/**
 * Deterministic treasury cash forecast (Rule #1: no AI in this path at
 * all). Combines an admin-supplied starting balance (this app has no real
 * bank integration - see lib/treasury-forecast.ts's scope note) with
 * obligations this app actually knows about: calculated-but-unposted
 * payroll runs, pending EWA requests, and the remaining EWA headroom every
 * active employee could still draw this month if they all maxed out at
 * once (the stress-test tail).
 */
export async function getTreasuryForecast(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;

  const startingParam = c.req.query("startingCashBalanceMinor");
  const startingCashBalanceMinor = startingParam ? Number(startingParam) : NaN;
  if (!startingParam || !Number.isFinite(startingCashBalanceMinor)) {
    return c.json(
      { error: { message: "startingCashBalanceMinor query param (integer minor units) is required", statusCode: 400 } },
      400,
    );
  }

  // Known, near-certain obligations: payroll runs that have been calculated
  // but not yet posted. A 'draft' run has no reliable total yet (may not
  // even be calculated); a 'posted' run has already moved through the
  // ledger, so it's history, not a forecast input.
  const calculatedRuns = await db
    .select({ totalNetMinor: payrollRuns.totalNetMinor })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.organizationId, orgId), eq(payrollRuns.status, "calculated")));
  const knownObligationsMinor = calculatedRuns.reduce((sum, r) => sum + r.totalNetMinor, 0);

  // Pending EWA requests, org-wide - any of these could be approved (and
  // paid out) at any time, regardless of which period they're against.
  const pendingRequests = await db
    .select({ requestedMinor: ewaRequests.requestedMinor })
    .from(ewaRequests)
    .where(and(eq(ewaRequests.organizationId, orgId), eq(ewaRequests.status, "pending")));
  const pendingEwaMinor = pendingRequests.reduce((sum, r) => sum + r.requestedMinor, 0);

  // Stress-test tail: how much more EWA headroom exists this month across
  // every active employee, on top of what's already pending/approved.
  const { periodStart, periodEnd } = currentMonthBounds();
  const asOfDate = new Date().toISOString().slice(0, 10);

  const scoped = scopedDb(db, orgId);
  const active = await scoped.employees.list({ limit: 1000, offset: 0 });
  const currentSalaries = await scoped.salaryRecords.currentFor(active.map((e) => e.id));

  // One batched query for this month's already-approved-or-pending EWA
  // amounts, grouped by employee in code - not N+1 (database-indexing.md
  // rule 3).
  const activeIds = active.map((e) => e.id);
  const monthRequests =
    activeIds.length === 0
      ? []
      : await db
          .select({ employeeId: ewaRequests.employeeId, requestedMinor: ewaRequests.requestedMinor })
          .from(ewaRequests)
          .where(
            and(
              eq(ewaRequests.organizationId, orgId),
              inArray(ewaRequests.employeeId, activeIds),
              eq(ewaRequests.periodStart, periodStart),
              eq(ewaRequests.periodEnd, periodEnd),
              inArray(ewaRequests.status, ["approved", "pending"]),
            ),
          );
  const alreadyByEmployee = new Map<string, number>();
  for (const r of monthRequests) {
    alreadyByEmployee.set(r.employeeId, (alreadyByEmployee.get(r.employeeId) ?? 0) + r.requestedMinor);
  }

  let potentialAdditionalEwaMinor = 0;
  for (const e of active) {
    const salary = currentSalaries.get(e.id);
    if (!salary) continue;
    const accrual = computeAccrual({
      annualSalaryMinor: Math.round(Number(salary.amount) * 100),
      periodStart,
      periodEnd,
      asOfDate,
    });
    const already = alreadyByEmployee.get(e.id) ?? 0;
    potentialAdditionalEwaMinor += computeMaxAdvance(accrual.accruedGrossMinor, already);
  }

  const forecast = computeTreasuryForecast({
    startingCashBalanceMinor,
    knownObligationsMinor,
    pendingEwaMinor,
    potentialAdditionalEwaMinor,
  });

  return c.json({
    ...forecast,
    inputs: {
      startingCashBalanceMinor,
      knownObligationsMinor,
      pendingEwaMinor,
      potentialAdditionalEwaMinor,
      periodStart,
      periodEnd,
      calculatedRunCount: calculatedRuns.length,
      pendingEwaCount: pendingRequests.length,
    },
  });
}
