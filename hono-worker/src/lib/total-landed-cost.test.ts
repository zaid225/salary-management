import { describe, expect, it } from "vitest";
import { computeTotalLandedCost, NATIVE_CURRENCY_BY_JURISDICTION } from "./total-landed-cost.js";

describe("computeTotalLandedCost — US-CA", () => {
  it("hand-verified: $100,000 gross", () => {
    const result = computeTotalLandedCost({ annualSalaryMinor: 100_000_00, jurisdiction: "US-CA" });
    if (!result.supported) throw new Error("expected supported result");
    expect(result.currency).toBe("USD");
    // 100,000 * 6.2% = 6,200; * 1.45% = 1,450; * 3% = 3,000. Total 10,650.
    expect(result.employerContributions).toEqual([
      { type: "employer_social_security", amountMinor: 6_200_00 },
      { type: "employer_medicare", amountMinor: 1_450_00 },
      { type: "unemployment_insurance", amountMinor: 3_000_00 },
    ]);
    expect(result.totalEmployerContributionsMinor).toBe(10_650_00);
    expect(result.totalLandedCostAnnualMinor).toBe(110_650_00);
  });
});

describe("computeTotalLandedCost — IN", () => {
  it("hand-verified: ₹1,000,000 gross", () => {
    const result = computeTotalLandedCost({ annualSalaryMinor: 1_000_000_00, jurisdiction: "IN" });
    if (!result.supported) throw new Error("expected supported result");
    expect(result.currency).toBe("INR");
    // EPF: 1,000,000 * 12% = 120,000. Gratuity: 1,000,000 * (15/26/12) = 48,076.92... -> 48,076.92 rounds to nearest paisa: 4,807,692 paise.
    const epf = result.employerContributions.find((c) => c.type === "employer_epf")!;
    const gratuity = result.employerContributions.find((c) => c.type === "gratuity_provision")!;
    expect(epf.amountMinor).toBe(12_000_000);
    expect(gratuity.amountMinor).toBe(4_807_692);
    expect(result.totalEmployerContributionsMinor).toBe(16_807_692);
    expect(result.totalLandedCostAnnualMinor).toBe(116_807_692);
  });
});

describe("computeTotalLandedCost — UK", () => {
  it("hand-verified: £60,000 gross, above the secondary NI threshold", () => {
    const result = computeTotalLandedCost({ annualSalaryMinor: 60_000_00, jurisdiction: "UK" });
    if (!result.supported) throw new Error("expected supported result");
    expect(result.currency).toBe("GBP");
    // NI base: 60,000 - 9,100 = 50,900. NI: 50,900 * 13.8% = 7,024.20.
    expect(result.employerContributions).toEqual([
      { type: "employer_national_insurance", amountMinor: 702_420 },
    ]);
    expect(result.totalLandedCostAnnualMinor).toBe(67_024_20);
  });

  it("charges zero employer NI below the secondary threshold", () => {
    const result = computeTotalLandedCost({ annualSalaryMinor: 5_000_00, jurisdiction: "UK" });
    if (!result.supported) throw new Error("expected supported result");
    expect(result.employerContributions[0]!.amountMinor).toBe(0);
    expect(result.totalLandedCostAnnualMinor).toBe(5_000_00);
  });
});

describe("computeTotalLandedCost — unsupported jurisdiction", () => {
  it("returns supported: false rather than guessing", () => {
    const result = computeTotalLandedCost({ annualSalaryMinor: 100_00, jurisdiction: "FR" });
    expect(result.supported).toBe(false);
  });
});

describe("NATIVE_CURRENCY_BY_JURISDICTION", () => {
  it("maps every supported jurisdiction to its native currency", () => {
    expect(NATIVE_CURRENCY_BY_JURISDICTION).toEqual({ "US-CA": "USD", IN: "INR", UK: "GBP" });
  });
});
