// RSU & Equity Tax Optimizer - the deterministic half (Rule #1: LLMs never
// do math, and neither the vesting schedule nor the tax withholding nor
// the strategy comparison below involves any AI). "Optimizer" here means
// what it should mean for money: compute every strategy's exact numbers
// and let a human pick, never a model guessing which one is "best."
//
// SCOPE NOTE: no persistent grant-tracking table exists in this pass -
// these are stateless calculators (same shape as treasury-forecast.ts and
// total-landed-cost.ts), not a system that remembers a real employee's real
// grants. A real product needs an rsu_grants table and this math applied
// against it over time; that's future work, not built here.

import { SOCIAL_SECURITY_RATE, MEDICARE_RATE, type DeductionLine, type Minor } from "./payroll-engine.js";

// --- Vesting schedule -------------------------------------------------

export interface VestEvent {
  monthIndex: number; // months elapsed since vestingStartDate
  vestDate: string; // YYYY-MM-DD
  shares: number; // integer - RSUs never vest a fractional share
}

const CLIFF_MONTHS = 12;
const TOTAL_MONTHS = 48;
const MONTHLY_MONTHS = TOTAL_MONTHS - CLIFF_MONTHS; // 36

/**
 * The standard 4-year/1-year-cliff schedule: 25% at the 12-month cliff,
 * then the remaining 75% in 36 equal monthly installments. Share counts are
 * integers throughout (Math.floor per month), with the rounding remainder
 * folded into the final month so the sum across every event always equals
 * totalShares exactly - never fewer, never more, regardless of how poorly
 * totalShares divides.
 */
export function computeVestingSchedule(input: { totalShares: number; vestingStartDate: string }): VestEvent[] {
  const cliffShares = Math.floor(input.totalShares * 0.25);
  const remainingShares = input.totalShares - cliffShares;
  const perMonth = Math.floor(remainingShares / MONTHLY_MONTHS);

  const events: VestEvent[] = [
    { monthIndex: CLIFF_MONTHS, vestDate: addMonths(input.vestingStartDate, CLIFF_MONTHS), shares: cliffShares },
  ];

  let allocated = 0;
  for (let m = 1; m < MONTHLY_MONTHS; m++) {
    events.push({
      monthIndex: CLIFF_MONTHS + m,
      vestDate: addMonths(input.vestingStartDate, CLIFF_MONTHS + m),
      shares: perMonth,
    });
    allocated += perMonth;
  }
  events.push({
    monthIndex: TOTAL_MONTHS,
    vestDate: addMonths(input.vestingStartDate, TOTAL_MONTHS),
    shares: remainingShares - allocated, // remainder - keeps the total exact
  });

  return events;
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = m - 1 + months;
  const newYear = y + Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  // Clamp the day to the target month's length (a Jan 31 grant date has no
  // Feb 31 to vest on) rather than overflowing into the following month.
  const daysInNewMonth = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
  const newDay = Math.min(d, daysInNewMonth);
  return `${newYear}-${String(newMonth).padStart(2, "0")}-${String(newDay).padStart(2, "0")}`;
}

// --- Vest-time tax withholding -----------------------------------------

// IRS federal supplemental wage flat rate (used for RSU vests instead of
// the employee's own W-4 withholding table) - this scaffold ignores the
// $1M-cumulative-supplemental-wages-in-a-year threshold that pushes the
// excess to 37%, same "illustrative, not authoritative" discipline as
// payroll-engine.ts's own brackets.
const FEDERAL_SUPPLEMENTAL_RATE = 0.22;
// California supplemental wage rate for bonuses/stock options (EDD).
const CA_SUPPLEMENTAL_RATE = 0.1023;

export type VestTaxResult =
  | {
      supported: true;
      jurisdiction: string;
      sharesVesting: number;
      fmvPerShareMinor: Minor;
      grossValueMinor: Minor;
      withholding: DeductionLine[];
      totalTaxMinor: Minor;
      netValueMinor: Minor;
    }
  | { supported: false; jurisdiction: string; reason: string };

/**
 * RSU vest income is FICA-taxable ordinary income, withheld at the flat
 * supplemental rate rather than through the employee's own W-4 elections -
 * this is why it's a separate calculator from payroll-engine.ts's
 * progressive-bracket paycheck math, not a duplicate of it.
 */
export function computeVestWithholding(input: {
  sharesVesting: number;
  fmvPerShareMinor: Minor;
  jurisdiction: string;
}): VestTaxResult {
  if (input.jurisdiction !== "US-CA") {
    return {
      supported: false,
      jurisdiction: input.jurisdiction,
      reason: `No RSU vest-tax rule set implemented for jurisdiction "${input.jurisdiction}"`,
    };
  }

  const grossValueMinor = Math.round(input.sharesVesting * input.fmvPerShareMinor);

  const withholding: DeductionLine[] = [
    { type: "federal_income_tax", amountMinor: Math.round(grossValueMinor * FEDERAL_SUPPLEMENTAL_RATE) },
    { type: "state_income_tax", amountMinor: Math.round(grossValueMinor * CA_SUPPLEMENTAL_RATE) },
    { type: "social_security", amountMinor: Math.round(grossValueMinor * SOCIAL_SECURITY_RATE) },
    { type: "medicare", amountMinor: Math.round(grossValueMinor * MEDICARE_RATE) },
  ];
  const totalTaxMinor = withholding.reduce((sum, d) => sum + d.amountMinor, 0);

  return {
    supported: true,
    jurisdiction: input.jurisdiction,
    sharesVesting: input.sharesVesting,
    fmvPerShareMinor: input.fmvPerShareMinor,
    grossValueMinor,
    withholding,
    totalTaxMinor,
    netValueMinor: grossValueMinor - totalTaxMinor,
  };
}

// --- Strategy comparison ("the optimizer") -----------------------------

export type EquityStrategy = "sell_to_cover" | "same_day_sale" | "hold_pay_cash";

export interface StrategyResult {
  strategy: EquityStrategy;
  sharesSold: number;
  sharesRetained: number;
  cashOutlayMinor: Minor; // cash the employee must pay out of pocket to cover the tax bill
  cashProceedsMinor: Minor; // net cash received from selling shares, after the tax bill
  retainedValueMinor: Minor; // value of shares kept, at the given FMV
}

/**
 * Every RSU vest needs the tax bill covered somehow - these are the three
 * standard ways, computed exactly rather than recommended by a model. A
 * human picks based on their own cash position and conviction in the
 * stock, not something this app can or should decide for them.
 */
export function computeEquityStrategies(input: {
  sharesVesting: number;
  fmvPerShareMinor: Minor;
  totalTaxMinor: Minor;
}): StrategyResult[] {
  const { sharesVesting, fmvPerShareMinor, totalTaxMinor } = input;

  const sellToCoverShares = fmvPerShareMinor > 0 ? Math.ceil(totalTaxMinor / fmvPerShareMinor) : sharesVesting;
  const sellToCover: StrategyResult = {
    strategy: "sell_to_cover",
    sharesSold: sellToCoverShares,
    sharesRetained: sharesVesting - sellToCoverShares,
    cashOutlayMinor: 0,
    cashProceedsMinor: sellToCoverShares * fmvPerShareMinor - totalTaxMinor,
    retainedValueMinor: (sharesVesting - sellToCoverShares) * fmvPerShareMinor,
  };

  const sameDaySale: StrategyResult = {
    strategy: "same_day_sale",
    sharesSold: sharesVesting,
    sharesRetained: 0,
    cashOutlayMinor: 0,
    cashProceedsMinor: sharesVesting * fmvPerShareMinor - totalTaxMinor,
    retainedValueMinor: 0,
  };

  const holdPayCash: StrategyResult = {
    strategy: "hold_pay_cash",
    sharesSold: 0,
    sharesRetained: sharesVesting,
    cashOutlayMinor: totalTaxMinor,
    cashProceedsMinor: 0,
    retainedValueMinor: sharesVesting * fmvPerShareMinor,
  };

  return [sellToCover, sameDaySale, holdPayCash];
}
