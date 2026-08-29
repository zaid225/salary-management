// Deterministic gross-to-net engine. Ironclad rule #1: LLMs never do math -
// this file has zero AI in it and never will. Every function here is pure
// (same input -> same output, no I/O, no Date.now()), which is what makes
// it independently unit-testable and what makes a payroll run reproducible:
// re-running calculateRun on the same inputs must always produce the same
// numbers, byte for byte.
//
// IMPORTANT SCOPE NOTE: the tax rules below are a simplified, illustrative
// example for one jurisdiction (US federal + a flat single-state rate), not
// authoritative tax advice and not fit for real payroll. Real coverage
// needs per-jurisdiction rule sets kept current - that is exactly what the
// "Legal-to-Code Compliance Diff Engine" (architecture in the plan, not
// built) exists to maintain over time. Everything else in this engine
// (proration, integer-cent math, the orchestration shape) is real and
// reusable once real rule sets are plugged in.

export type Minor = number; // integer minor units (cents) - a payroll engine must never touch a float

export interface PayrollLineInput {
  employeeId: string;
  annualSalaryMinor: Minor;
  currency: string;
  jurisdiction: string; // e.g. "US-CA" - only this one is implemented
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD (inclusive)
}

export interface DeductionLine {
  type:
    | "federal_income_tax"
    | "state_income_tax"
    | "social_security"
    | "medicare"
    | "india_income_tax_tds"
    | "india_health_education_cess";
  amountMinor: Minor;
}

export type PayrollLineResult =
  | {
      supported: true;
      employeeId: string;
      grossMinor: Minor;
      deductions: DeductionLine[];
      netMinor: Minor;
      currency: string;
    }
  | { supported: false; employeeId: string; reason: string };

// Every day is exactly 86,400,000ms in UTC - this deliberately does not use
// a calendar library so the count is trivially auditable and independent of
// timezone/DST, which matters for a number that determines someone's pay.
function daysInclusive(startIso: string, endIso: string): number {
  const start = Date.UTC(...parseIsoDate(startIso));
  const end = Date.UTC(...parseIsoDate(endIso));
  return Math.round((end - start) / 86_400_000) + 1;
}

function parseIsoDate(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y!, m! - 1, d!];
}

function daysInYear(iso: string): number {
  const [y] = parseIsoDate(iso);
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return isLeap ? 366 : 365;
}

// Illustrative 2024 single-filer federal brackets (annual, USD minor units).
// Ordered ascending; the last bracket's upTo is Infinity.
const US_FEDERAL_BRACKETS_2024_SINGLE: { upToAnnualMinor: number; rate: number }[] = [
  { upToAnnualMinor: 1_160_000, rate: 0.1 },
  { upToAnnualMinor: 4_715_000, rate: 0.12 },
  { upToAnnualMinor: 10_052_500, rate: 0.22 },
  { upToAnnualMinor: 19_195_000, rate: 0.24 },
  { upToAnnualMinor: 24_357_500, rate: 0.32 },
  { upToAnnualMinor: 60_935_000, rate: 0.35 },
  { upToAnnualMinor: Infinity, rate: 0.37 },
];

// Illustrative flat state rate for the one example jurisdiction this engine
// supports (US-CA) - a real implementation needs CA's actual progressive
// brackets; a flat rate is a deliberate, documented simplification.
const STATE_FLAT_RATE: Record<string, number> = { "US-CA": 0.05 };

const SOCIAL_SECURITY_RATE = 0.062;
const MEDICARE_RATE = 0.0145;

/** Progressive tax on an annual amount, computed bracket-by-bracket. */
function progressiveTax(annualMinor: Minor, brackets: typeof US_FEDERAL_BRACKETS_2024_SINGLE): Minor {
  let tax = 0;
  let lower = 0;
  for (const bracket of brackets) {
    if (annualMinor <= lower) break;
    const taxableInBracket = Math.min(annualMinor, bracket.upToAnnualMinor) - lower;
    tax += taxableInBracket * bracket.rate;
    lower = bracket.upToAnnualMinor;
  }
  return Math.round(tax);
}

/**
 * Computes one employee's gross-to-net for one pay period. Pure and
 * deterministic: the same PayrollLineInput always produces the same
 * PayrollLineResult.
 */
export function computePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const periodDays = daysInclusive(input.periodStart, input.periodEnd);
  const yearDays = daysInYear(input.periodStart);
  const periodFraction = periodDays / yearDays;

  // Gross is the direct pro-rated share of annual salary - no AI, no
  // estimate, just the fraction of the year this period covers. Shared by
  // every jurisdiction below.
  const grossMinor = Math.round(input.annualSalaryMinor * periodFraction);

  if (input.jurisdiction === "US-CA") {
    return computeUsCaLine(input, grossMinor, periodFraction);
  }
  if (input.jurisdiction === "IN") {
    return computeIndiaLine(input, grossMinor, periodFraction);
  }
  return {
    supported: false,
    employeeId: input.employeeId,
    reason: `No tax rule set implemented for jurisdiction "${input.jurisdiction}"`,
  };
}

function computeUsCaLine(
  input: PayrollLineInput,
  grossMinor: Minor,
  periodFraction: number,
): PayrollLineResult {
  // Deductions are computed on the *annual* amount (correct progressive
  // bracket behavior), then taken pro-rata for the period - this is what
  // keeps a biweekly and a monthly run consistent with each other over a
  // full year, rather than each period recomputing brackets on an
  // annualized-per-period guess.
  const annualFederalTax = progressiveTax(input.annualSalaryMinor, US_FEDERAL_BRACKETS_2024_SINGLE);
  const federalIncomeTaxMinor = Math.round(annualFederalTax * periodFraction);

  const stateRate = STATE_FLAT_RATE[input.jurisdiction] ?? 0;
  const stateIncomeTaxMinor = Math.round(grossMinor * stateRate);

  const socialSecurityMinor = Math.round(grossMinor * SOCIAL_SECURITY_RATE);
  const medicareMinor = Math.round(grossMinor * MEDICARE_RATE);

  const deductions: DeductionLine[] = [
    { type: "federal_income_tax", amountMinor: federalIncomeTaxMinor },
    { type: "state_income_tax", amountMinor: stateIncomeTaxMinor },
    { type: "social_security", amountMinor: socialSecurityMinor },
    { type: "medicare", amountMinor: medicareMinor },
  ];

  return finalizeLine(input, grossMinor, deductions);
}

// India, New Tax Regime (the default regime since Budget 2023-24, FY2024-25
// / AY2025-26 slabs) - public, published rates, hardcoded deliberately
// rather than AI-generated: Rule #1 forbids an LLM from doing the actual
// tax math, and slab numbers are a matter of public law, not something an
// LLM should be trusted to "remember" correctly for a financial system.
// The AI-assisted path (payroll-tax-rules.controller.ts) exists for
// *proposing* updates to rule sets like this one, gated behind human
// sign-off - never for computing a real paycheck directly.
// Bracket boundaries as "rupees * 100" (100 paise = 1 rupee) rather than
// hand-grouped underscored literals - lakh notation (3,00,000) is easy to
// mis-transcribe by a factor of 10 when regrouped into thousands, which is
// exactly the bug this expression form avoids.
const RUPEES = 100;
const INDIA_NEW_REGIME_BRACKETS_FY2024_25: { upToAnnualMinor: number; rate: number }[] = [
  { upToAnnualMinor: 300_000 * RUPEES, rate: 0 }, // ₹3,00,000
  { upToAnnualMinor: 700_000 * RUPEES, rate: 0.05 }, // ₹7,00,000
  { upToAnnualMinor: 1_000_000 * RUPEES, rate: 0.1 }, // ₹10,00,000
  { upToAnnualMinor: 1_200_000 * RUPEES, rate: 0.15 }, // ₹12,00,000
  { upToAnnualMinor: 1_500_000 * RUPEES, rate: 0.2 }, // ₹15,00,000
  { upToAnnualMinor: Infinity, rate: 0.3 },
];
const INDIA_STANDARD_DEDUCTION_MINOR = 75_000 * RUPEES; // ₹75,000/year, new regime, salaried
// Section 87A rebate: taxable income at or below this makes tax fully zero
// under the new regime. Marginal-relief phase-out above the threshold is a
// documented simplification not implemented here.
const INDIA_REBATE_THRESHOLD_MINOR = 700_000 * RUPEES; // ₹7,00,000
const INDIA_CESS_RATE = 0.04; // Health & Education Cess, on tax after rebate

function computeIndiaLine(
  input: PayrollLineInput,
  grossMinor: Minor,
  periodFraction: number,
): PayrollLineResult {
  const taxableAnnualMinor = Math.max(0, input.annualSalaryMinor - INDIA_STANDARD_DEDUCTION_MINOR);

  let annualIncomeTax = progressiveTax(taxableAnnualMinor, INDIA_NEW_REGIME_BRACKETS_FY2024_25);
  if (taxableAnnualMinor <= INDIA_REBATE_THRESHOLD_MINOR) annualIncomeTax = 0; // Section 87A rebate

  const annualCess = Math.round(annualIncomeTax * INDIA_CESS_RATE);

  const incomeTaxMinor = Math.round(annualIncomeTax * periodFraction);
  const cessMinor = Math.round(annualCess * periodFraction);

  const deductions: DeductionLine[] = [
    { type: "india_income_tax_tds", amountMinor: incomeTaxMinor },
    { type: "india_health_education_cess", amountMinor: cessMinor },
  ];

  return finalizeLine(input, grossMinor, deductions);
}

function finalizeLine(input: PayrollLineInput, grossMinor: Minor, deductions: DeductionLine[]): PayrollLineResult {
  const totalDeductions = deductions.reduce((sum, d) => sum + d.amountMinor, 0);
  const netMinor = grossMinor - totalDeductions;

  return {
    supported: true,
    employeeId: input.employeeId,
    grossMinor,
    deductions,
    netMinor,
    currency: input.currency,
  };
}

/** Runs computePayrollLine over a batch, never throwing on one bad row. */
export function computePayrollRun(inputs: PayrollLineInput[]): PayrollLineResult[] {
  return inputs.map(computePayrollLine);
}

// --- Earned Wage Access accrual --------------------------------------
// Deterministic, same rules as everything above: pure function, integer
// minor units, no AI. Accrual is calendar-based (calendar days elapsed in
// the period / days in the period), not attendance-based - this codebase
// has no clock-in/time-tracking data source yet (HRIS sync is unbuilt), so
// "days worked" is approximated as "calendar days elapsed." A real EWA
// product needs actual attendance data; this is the illustrative version.
export interface AccrualInput {
  annualSalaryMinor: Minor;
  periodStart: string; // YYYY-MM-DD, the pay period this accrual is measured against
  periodEnd: string;
  asOfDate: string; // YYYY-MM-DD, "today" - passed in explicitly, never read from the clock internally
}

export interface AccrualResult {
  accruedGrossMinor: Minor; // gross earned so far this period, pro-rated by elapsed calendar days
  elapsedDays: number;
  periodDays: number;
}

export function computeAccrual(input: AccrualInput): AccrualResult {
  const periodDays = daysInclusive(input.periodStart, input.periodEnd);
  const clampedAsOf = input.asOfDate < input.periodStart ? input.periodStart : input.asOfDate > input.periodEnd ? input.periodEnd : input.asOfDate;
  const elapsedDays = daysInclusive(input.periodStart, clampedAsOf);
  const yearDays = daysInYear(input.periodStart);

  // Same annual-proration basis as computePayrollLine, just for the elapsed
  // slice of the period rather than the whole thing - keeps an EWA accrual
  // and the eventual payroll run's gross consistent with each other.
  const accruedGrossMinor = Math.round(input.annualSalaryMinor * (elapsedDays / yearDays));

  return { accruedGrossMinor, elapsedDays, periodDays };
}

// Illustrative cap, not a compliance-verified regulatory limit (EWA
// advance limits vary by US state and by country) - a real deployment
// needs this sourced from an actual, current rule set, same caveat as the
// tax brackets above.
export const EWA_MAX_ADVANCE_FRACTION = 0.5;

export function computeMaxAdvance(accruedGrossMinor: Minor, alreadyAdvancedMinor: Minor): Minor {
  const cap = Math.round(accruedGrossMinor * EWA_MAX_ADVANCE_FRACTION);
  return Math.max(0, cap - alreadyAdvancedMinor);
}
