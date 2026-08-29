// Global Total Landed Cost modeler - the deterministic half. Rule #1 still
// holds: this is pure arithmetic on employer-side contribution rates, never
// an LLM estimate. Complements payroll-engine.ts, which computes what the
// EMPLOYEE nets after their own deductions; this computes what the
// EMPLOYER actually pays on top of gross - the employer's own statutory
// contributions - which payroll-engine.ts deliberately doesn't touch.
//
// SCOPE NOTE: like payroll-engine.ts's own tax brackets, these employer
// contribution rates are illustrative/simplified for one jurisdiction each,
// not authoritative compliance figures (e.g. US unemployment insurance
// varies enormously by state and by employer's claims history; UK's
// Apprenticeship Levy and India's ESI are omitted entirely). Real coverage
// needs the same "Legal-to-Code" maintenance discipline as the tax
// brackets do.

export type Minor = number;

export interface ContributionLine {
  type:
    | "employer_social_security"
    | "employer_medicare"
    | "unemployment_insurance"
    | "employer_epf"
    | "gratuity_provision"
    | "employer_national_insurance";
  amountMinor: Minor;
}

export type TotalLandedCostResult =
  | {
      supported: true;
      jurisdiction: string;
      currency: string;
      grossAnnualMinor: Minor;
      employerContributions: ContributionLine[];
      totalEmployerContributionsMinor: Minor;
      totalLandedCostAnnualMinor: Minor;
    }
  | { supported: false; jurisdiction: string; reason: string };

export const NATIVE_CURRENCY_BY_JURISDICTION: Record<string, string> = {
  "US-CA": "USD",
  IN: "INR",
  UK: "GBP",
};

const US_EMPLOYER_SOCIAL_SECURITY_RATE = 0.062; // mirrors the employee-side match, uncapped here (same simplification as payroll-engine.ts)
const US_EMPLOYER_MEDICARE_RATE = 0.0145;
// FUTA/SUTA combined - genuinely varies by state and by employer's claims
// history; this is a single illustrative placeholder, not a real rate.
const US_UNEMPLOYMENT_INSURANCE_RATE = 0.03;

const INDIA_EMPLOYER_EPF_RATE = 0.12; // mirrors the employee-side match
// Statutory gratuity accrual: 15 days' pay per year of service, i.e.
// 15/26 of a month's pay per year worked - approximated here as a flat
// percentage of annual gross rather than tracking tenure.
const INDIA_GRATUITY_RATE = 15 / 26 / 12;

// UK Class 1 Secondary (employer) NI, 2024/25: 13.8% above the secondary
// threshold, uncapped above it (unlike the employee's own upper-limit band).
const UK_EMPLOYER_NI_SECONDARY_THRESHOLD_MINOR = 9_100 * 100;
const UK_EMPLOYER_NI_RATE = 0.138;

export function computeTotalLandedCost(input: { annualSalaryMinor: Minor; jurisdiction: string }): TotalLandedCostResult {
  const currency = NATIVE_CURRENCY_BY_JURISDICTION[input.jurisdiction];
  if (!currency) {
    return {
      supported: false,
      jurisdiction: input.jurisdiction,
      reason: `No employer-contribution rule set implemented for jurisdiction "${input.jurisdiction}"`,
    };
  }

  const employerContributions = computeContributions(input.annualSalaryMinor, input.jurisdiction);
  const totalEmployerContributionsMinor = employerContributions.reduce((sum, c) => sum + c.amountMinor, 0);

  return {
    supported: true,
    jurisdiction: input.jurisdiction,
    currency,
    grossAnnualMinor: input.annualSalaryMinor,
    employerContributions,
    totalEmployerContributionsMinor,
    totalLandedCostAnnualMinor: input.annualSalaryMinor + totalEmployerContributionsMinor,
  };
}

function computeContributions(annualSalaryMinor: Minor, jurisdiction: string): ContributionLine[] {
  if (jurisdiction === "US-CA") {
    return [
      { type: "employer_social_security", amountMinor: Math.round(annualSalaryMinor * US_EMPLOYER_SOCIAL_SECURITY_RATE) },
      { type: "employer_medicare", amountMinor: Math.round(annualSalaryMinor * US_EMPLOYER_MEDICARE_RATE) },
      { type: "unemployment_insurance", amountMinor: Math.round(annualSalaryMinor * US_UNEMPLOYMENT_INSURANCE_RATE) },
    ];
  }
  if (jurisdiction === "IN") {
    return [
      { type: "employer_epf", amountMinor: Math.round(annualSalaryMinor * INDIA_EMPLOYER_EPF_RATE) },
      { type: "gratuity_provision", amountMinor: Math.round(annualSalaryMinor * INDIA_GRATUITY_RATE) },
    ];
  }
  if (jurisdiction === "UK") {
    const niBase = Math.max(0, annualSalaryMinor - UK_EMPLOYER_NI_SECONDARY_THRESHOLD_MINOR);
    return [{ type: "employer_national_insurance", amountMinor: Math.round(niBase * UK_EMPLOYER_NI_RATE) }];
  }
  return [];
}
