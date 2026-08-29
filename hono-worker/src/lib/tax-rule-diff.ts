// Legal-to-Code Compliance Diff Engine - the deterministic half. Rule #1
// still holds here: nothing in this file infers or adjusts a bracket rate.
// It only ever runs the SAME pure progressiveTax() the real payroll engine
// runs (lib/payroll-engine.ts), once against the live bracket set and once
// against a proposed replacement, over a fixed set of representative
// salaries - and reports the difference. That diff is what gets stored as
// an ai_proposals row and gated behind human sign-off (Rule #4); this
// function never writes anywhere and never decides anything is "correct."
//
// SCOPE NOTE: this is the part of the "sandbox" that can actually run
// inside a Cloudflare Worker - pure computation over data already in hand.
// The isolated, egress-whitelisted microVM execution described in the
// original design (for running arbitrary LLM-generated rule *code*, not
// just a bracket table) needs a separate compute layer Workers cannot
// provide (no child processes, no microVMs in an isolate) - documented as
// architecture, not built, same as the orchestrator/HITL runtime.
import { progressiveTax, type TaxBracket } from "./payroll-engine.js";

export interface TaxDiffScenario {
  annualSalaryMinor: number;
  currentAnnualTaxMinor: number;
  proposedAnnualTaxMinor: number;
  deltaMinor: number; // positive = proposed charges more tax than current
}

export interface TaxRuleDiff {
  scenarios: TaxDiffScenario[];
  totalDeltaMinor: number; // sum of deltaMinor across every scenario - the single "does this raise or lower total tax" signal
}

// SCOPE NOTE: this diffs only the progressive income-tax bracket table
// itself (the piece a new tax law actually changes) - not the full
// jurisdiction pipeline. Standard deductions, rebates, cess, social
// security/NI and every other deduction stay held constant on both sides
// of the comparison; they aren't part of what "Legal-to-Code" is proposing
// a change to here.

/**
 * Representative annual salaries to run both bracket sets against. Fixed
 * and public (not derived from any real employee) so a diff is reproducible
 * and never leaks real compensation data into an AI-adjacent artifact -
 * same PII-boundary discipline as the pre-flight auditor, just applied by
 * construction here instead of by tokenization.
 */
export function goldenSalariesMinor(currencyMinorPerUnit: number): number[] {
  return [30_000, 60_000, 100_000, 250_000, 600_000].map((n) => n * currencyMinorPerUnit);
}

export function computeTaxRuleDiff(
  currentBrackets: TaxBracket[],
  proposedBrackets: TaxBracket[],
  salariesMinor: number[],
): TaxRuleDiff {
  const scenarios = salariesMinor.map((annualSalaryMinor) => {
    const currentAnnualTaxMinor = progressiveTax(annualSalaryMinor, currentBrackets);
    const proposedAnnualTaxMinor = progressiveTax(annualSalaryMinor, proposedBrackets);
    return {
      annualSalaryMinor,
      currentAnnualTaxMinor,
      proposedAnnualTaxMinor,
      deltaMinor: proposedAnnualTaxMinor - currentAnnualTaxMinor,
    };
  });
  const totalDeltaMinor = scenarios.reduce((sum, s) => sum + s.deltaMinor, 0);
  return { scenarios, totalDeltaMinor };
}
