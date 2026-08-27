import type { Context } from "hono";
import { sql } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";

// db.execute<T>() constrains T to Record<string, unknown>, so these are
// type aliases with an index signature rather than plain interfaces.
type SummaryRow = {
  headcount: number;
  avg_usd: string | null;
  median_usd: string | null;
  total_cost_usd: string | null;
  [k: string]: unknown;
};

type BreakdownRow = {
  key: string;
  headcount: number;
  avg_usd: string | null;
  [k: string]: unknown;
};

// The "current salary, normalized to USD" CTE every query below starts
// from. An employee whose currency has no fx_rates row is excluded rather
// than erroring - one unrecognized currency shouldn't blank the whole
// dashboard.
function usdCte(orgId: string, extraSelect: ReturnType<typeof sql> | null) {
  return sql`
    WITH current_salary AS (
      SELECT DISTINCT ON (employee_id) employee_id, amount, currency
      FROM salary_records
      WHERE organization_id = ${orgId}
      ORDER BY employee_id, effective_date DESC
    ),
    usd AS (
      SELECT cs.employee_id, cs.amount * fx.rate_to_usd AS amount_usd${extraSelect ?? sql``}
      FROM current_salary cs
      JOIN fx_rates fx ON fx.currency = cs.currency
      JOIN employees e ON e.id = cs.employee_id
      WHERE e.organization_id = ${orgId} AND e.employment_status = 'active'
    )
  `;
}

// Live SQL against a small, indexed table - at 10k rows each of these runs
// in single-digit milliseconds (design spec §1), so a precomputed rollup
// would only add staleness risk for no measurable benefit.
export async function getAnalyticsSummary(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;

  const summaryResult = await db.execute<SummaryRow>(sql`
    ${usdCte(orgId, null)}
    SELECT
      COUNT(*)::int AS headcount,
      AVG(amount_usd)::numeric AS avg_usd,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount_usd) AS median_usd,
      SUM(amount_usd)::numeric AS total_cost_usd
    FROM usd
  `);

  const byCountry = await db.execute<BreakdownRow>(sql`
    ${usdCte(orgId, sql`, e.country`)}
    SELECT country AS key, COUNT(*)::int AS headcount, AVG(amount_usd)::numeric AS avg_usd
    FROM usd GROUP BY country ORDER BY country
  `);

  const byDepartment = await db.execute<BreakdownRow>(sql`
    ${usdCte(orgId, sql`, e.department`)}
    SELECT department AS key, COUNT(*)::int AS headcount, AVG(amount_usd)::numeric AS avg_usd
    FROM usd GROUP BY department ORDER BY department
  `);

  const byLevel = await db.execute<BreakdownRow>(sql`
    ${usdCte(orgId, sql`, e.level`)}
    SELECT level AS key, COUNT(*)::int AS headcount, AVG(amount_usd)::numeric AS avg_usd
    FROM usd GROUP BY level ORDER BY level
  `);

  const summary = summaryResult[0] as SummaryRow | undefined;

  return c.json({
    headcount: summary?.headcount ?? 0,
    avgUsd: summary?.avg_usd ? Number(summary.avg_usd) : 0,
    medianUsd: summary?.median_usd ? Number(summary.median_usd) : 0,
    totalCostUsd: summary?.total_cost_usd ? Number(summary.total_cost_usd) : 0,
    byCountry: byCountry.map((r) => ({ country: r.key, headcount: r.headcount, avgUsd: Number(r.avg_usd ?? 0) })),
    byDepartment: byDepartment.map((r) => ({
      department: r.key,
      headcount: r.headcount,
      avgUsd: Number(r.avg_usd ?? 0),
    })),
    byLevel: byLevel.map((r) => ({ level: r.key, headcount: r.headcount, avgUsd: Number(r.avg_usd ?? 0) })),
  });
}
