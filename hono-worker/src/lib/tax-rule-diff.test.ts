import { describe, expect, it } from "vitest";
import { computeTaxRuleDiff, goldenSalariesMinor } from "./tax-rule-diff.js";
import type { TaxBracket } from "./payroll-engine.js";

describe("goldenSalariesMinor", () => {
  it("scales the fixed representative salaries by the given currency's minor-unit factor", () => {
    expect(goldenSalariesMinor(100)).toEqual([3_000_000, 6_000_000, 10_000_000, 25_000_000, 60_000_000]);
  });
});

describe("computeTaxRuleDiff", () => {
  const current: TaxBracket[] = [
    { upToAnnualMinor: 1_000_00, rate: 0.1 },
    { upToAnnualMinor: Infinity, rate: 0.2 },
  ];

  it("reports zero delta at every scenario when the proposed brackets are identical", () => {
    const diff = computeTaxRuleDiff(current, current, [500_00, 1_500_00]);
    expect(diff.scenarios.every((s) => s.deltaMinor === 0)).toBe(true);
    expect(diff.totalDeltaMinor).toBe(0);
  });

  it("hand-verified: a rate increase on the top bracket only affects income above its threshold", () => {
    const proposed: TaxBracket[] = [
      { upToAnnualMinor: 1_000_00, rate: 0.1 }, // unchanged
      { upToAnnualMinor: Infinity, rate: 0.25 }, // 0.2 -> 0.25
    ];
    // $500 salary: fully inside the unchanged first bracket - current tax
    // 500*0.1=50, proposed tax 500*0.1=50, delta 0.
    // $1,500 salary: $1,000 at 10% = 100, remaining $500 at the top bracket -
    // current 500*0.2=100 (total 200), proposed 500*0.25=125 (total 225).
    // Delta = 225 - 200 = 25.
    const diff = computeTaxRuleDiff(current, proposed, [500_00, 1_500_00]);
    expect(diff.scenarios[0]).toEqual({
      annualSalaryMinor: 500_00,
      currentAnnualTaxMinor: 50_00,
      proposedAnnualTaxMinor: 50_00,
      deltaMinor: 0,
    });
    expect(diff.scenarios[1]).toEqual({
      annualSalaryMinor: 1_500_00,
      currentAnnualTaxMinor: 200_00,
      proposedAnnualTaxMinor: 225_00,
      deltaMinor: 25_00,
    });
    expect(diff.totalDeltaMinor).toBe(25_00);
  });

  it("a rate cut produces a negative delta (proposed charges less)", () => {
    const proposed: TaxBracket[] = [
      { upToAnnualMinor: 1_000_00, rate: 0.05 }, // 0.1 -> 0.05
      { upToAnnualMinor: Infinity, rate: 0.2 },
    ];
    const diff = computeTaxRuleDiff(current, proposed, [1_000_00]);
    // Full $1,000 in the first bracket: current 100, proposed 50, delta -50.
    expect(diff.scenarios[0]!.deltaMinor).toBe(-50_00);
    expect(diff.totalDeltaMinor).toBe(-50_00);
  });

  it("returns an empty scenario list for an empty salary set", () => {
    const diff = computeTaxRuleDiff(current, current, []);
    expect(diff.scenarios).toEqual([]);
    expect(diff.totalDeltaMinor).toBe(0);
  });
});
