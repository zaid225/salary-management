import type { Context } from "hono";
import { inArray } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { fxRates } from "../models/schema.js";
import { computeTotalLandedCost, NATIVE_CURRENCY_BY_JURISDICTION } from "../lib/total-landed-cost.js";

const SUPPORTED_JURISDICTIONS = Object.keys(NATIVE_CURRENCY_BY_JURISDICTION);

/**
 * Global Total Landed Cost modeler (Rule #1: no AI in this path). Takes one
 * USD hiring budget and shows what it actually costs to land the same role
 * in each jurisdiction: the budget is converted to that jurisdiction's
 * native currency via fx_rates (design spec's existing fixed FX snapshot,
 * not a live dependency), employer-side statutory contributions are added
 * on top (lib/total-landed-cost.ts), and the true cost is converted back
 * to USD for a fair side-by-side comparison.
 */
export async function compareTotalLandedCost(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const budgetParam = c.req.query("budgetUsdMinor");
  const budgetUsdMinor = budgetParam ? Number(budgetParam) : NaN;
  if (!budgetParam || !Number.isFinite(budgetUsdMinor) || budgetUsdMinor <= 0) {
    return c.json(
      { error: { message: "budgetUsdMinor query param (positive integer minor units) is required", statusCode: 400 } },
      400,
    );
  }

  const jurisdictionsParam = c.req.query("jurisdictions");
  const jurisdictions = jurisdictionsParam ? jurisdictionsParam.split(",") : SUPPORTED_JURISDICTIONS;
  const unknown = jurisdictions.filter((j) => !SUPPORTED_JURISDICTIONS.includes(j));
  if (unknown.length > 0) {
    return c.json(
      { error: { message: `Unsupported jurisdiction(s): ${unknown.join(", ")}`, statusCode: 400 } },
      400,
    );
  }

  const currencies = [...new Set(jurisdictions.map((j) => NATIVE_CURRENCY_BY_JURISDICTION[j]!))];
  const rateRows = await db.select().from(fxRates).where(inArray(fxRates.currency, currencies));
  const rateByCurrency = new Map(rateRows.map((r) => [r.currency, Number(r.rateToUsd)]));

  const results = jurisdictions.map((jurisdiction) => {
    const currency = NATIVE_CURRENCY_BY_JURISDICTION[jurisdiction]!;
    const rateToUsd = rateByCurrency.get(currency);
    // A currency with no fx_rates row is excluded from the comparison
    // rather than silently computed with a made-up rate - same "excluded,
    // not blanked" discipline as analytics.controller.ts's INNER JOIN.
    if (rateToUsd === undefined) {
      return { jurisdiction, currency, missingFxRate: true as const };
    }

    const localBudgetMinor = Math.round(budgetUsdMinor / rateToUsd);
    const tlc = computeTotalLandedCost({ annualSalaryMinor: localBudgetMinor, jurisdiction });
    if (!tlc.supported) {
      return { jurisdiction, currency, missingFxRate: false as const, error: tlc.reason };
    }

    return {
      jurisdiction,
      currency,
      missingFxRate: false as const,
      grossLocalMinor: tlc.grossAnnualMinor,
      employerContributions: tlc.employerContributions,
      totalEmployerContributionsLocalMinor: tlc.totalEmployerContributionsMinor,
      totalLandedCostLocalMinor: tlc.totalLandedCostAnnualMinor,
      // Converted back to USD using the same fixed rate - what the "true
      // cost" of this budget is once employer contributions are added, in
      // the currency the comparison started in.
      totalLandedCostUsdMinor: Math.round(tlc.totalLandedCostAnnualMinor * rateToUsd),
    };
  });

  return c.json({ budgetUsdMinor, results });
}
