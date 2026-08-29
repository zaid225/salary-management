import { describe, it, expect } from "vitest";
import { computeAccrual, computeMaxAdvance, computePayrollLine, computePayrollRun, type PayrollLineInput } from "./payroll-engine.js";

const BASE: PayrollLineInput = {
  employeeId: "emp-1",
  annualSalaryMinor: 12_000_000, // $120,000.00
  currency: "USD",
  jurisdiction: "US-CA",
  periodStart: "2024-01-01",
  periodEnd: "2024-01-31", // 31-day period
};

describe("computePayrollLine", () => {
  it("flags an unsupported jurisdiction instead of guessing at a number", () => {
    const result = computePayrollLine({ ...BASE, jurisdiction: "DE" });
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toContain("DE");
      expect(result.employeeId).toBe("emp-1");
    }
  });

  it("prorates gross pay by the exact fraction of the year the period covers", () => {
    const result = computePayrollLine(BASE);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    // 31 days / 366 (2024 is a leap year) of $120,000.
    const expectedGross = Math.round(12_000_000 * (31 / 366));
    expect(result.grossMinor).toBe(expectedGross);
  });

  it("never produces a negative net or a net exceeding gross", () => {
    for (const annual of [0, 1_000_00, 12_000_000, 60_935_000, 500_000_000]) {
      const result = computePayrollLine({ ...BASE, annualSalaryMinor: annual });
      expect(result.supported).toBe(true);
      if (!result.supported) continue;
      expect(result.netMinor).toBeGreaterThanOrEqual(0);
      expect(result.netMinor).toBeLessThanOrEqual(result.grossMinor);
    }
  });

  it("every deduction line is an integer number of cents", () => {
    const result = computePayrollLine(BASE);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(Number.isInteger(result.grossMinor)).toBe(true);
    expect(Number.isInteger(result.netMinor)).toBe(true);
    for (const d of result.deductions) {
      expect(Number.isInteger(d.amountMinor)).toBe(true);
      expect(d.amountMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it("gross minus the sum of deductions equals net, exactly", () => {
    const result = computePayrollLine(BASE);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const totalDeductions = result.deductions.reduce((sum, d) => sum + d.amountMinor, 0);
    expect(result.grossMinor - totalDeductions).toBe(result.netMinor);
  });

  it("a higher annual salary never produces a lower net for the same period", () => {
    const lower = computePayrollLine({ ...BASE, annualSalaryMinor: 8_000_000 });
    const higher = computePayrollLine({ ...BASE, annualSalaryMinor: 9_000_000 });
    expect(lower.supported && higher.supported).toBe(true);
    if (!lower.supported || !higher.supported) return;
    expect(higher.netMinor).toBeGreaterThan(lower.netMinor);
  });

  it("progressive federal bracket math: a salary straddling two brackets pays the higher rate only on the excess", () => {
    // $120,000 straddles the 22% bracket (up to $100,525) and the 24%
    // bracket. Hand-computed annual federal tax for a $120,000 single filer
    // under the brackets in this file:
    //   10% * 11,600 = 1,160
    //   12% * (47,150-11,600) = 4,266
    //   22% * (100,525-47,150) = 11,742.5
    //   24% * (120,000-100,525) = 4,674
    //   total = 21,842.50 exactly -> 2,184,250 minor units, no rounding needed
    const fullYear: PayrollLineInput = {
      ...BASE,
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31", // full 366-day year -> periodFraction = 1
    };
    const result = computePayrollLine(fullYear);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const federal = result.deductions.find((d) => d.type === "federal_income_tax")!;
    expect(federal.amountMinor).toBe(2_184_250);
  });

  it("is deterministic: identical input always produces identical output", () => {
    const a = computePayrollLine(BASE);
    const b = computePayrollLine(BASE);
    expect(a).toEqual(b);
  });
});

describe("computePayrollRun", () => {
  it("processes a batch and never throws on one unsupported row", () => {
    const results = computePayrollRun([
      BASE,
      { ...BASE, employeeId: "emp-2", jurisdiction: "FR" },
      { ...BASE, employeeId: "emp-3" },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]!.supported).toBe(true);
    expect(results[1]!.supported).toBe(false);
    expect(results[2]!.supported).toBe(true);
  });
});

describe("computePayrollLine — India (IN)", () => {
  const INDIA_BASE: PayrollLineInput = {
    employeeId: "emp-in-1",
    annualSalaryMinor: 12_00_000_00, // ₹12,00,000
    currency: "INR",
    jurisdiction: "IN",
    periodStart: "2024-01-01",
    periodEnd: "2024-12-31", // full year, periodFraction = 1
  };

  it("applies the Section 87A rebate: zero tax when taxable income is at or below the threshold", () => {
    // ₹6,50,000 annual - ₹75,000 standard deduction = ₹5,75,000 taxable,
    // under the ₹7,00,000 rebate threshold -> tax must be exactly zero.
    const result = computePayrollLine({ ...INDIA_BASE, annualSalaryMinor: 6_50_000_00 });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const tax = result.deductions.find((d) => d.type === "india_income_tax_tds")!;
    const cess = result.deductions.find((d) => d.type === "india_health_education_cess")!;
    expect(tax.amountMinor).toBe(0);
    expect(cess.amountMinor).toBe(0);
    expect(result.netMinor).toBe(result.grossMinor);
  });

  it("computes progressive slab tax plus 4% cess above the rebate threshold", () => {
    // ₹12,00,000 - ₹75,000 standard deduction = ₹11,25,000 taxable.
    // Slabs: 0% to 3L, 5% on 3-7L (=20,000), 10% on 7-10L (=30,000),
    // 15% on 10-11.25L (=18,750). Total income tax = 68,750.
    // Cess = 4% of 68,750 = 2,750. Total withheld = 71,500.
    const result = computePayrollLine(INDIA_BASE);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const tax = result.deductions.find((d) => d.type === "india_income_tax_tds")!;
    const cess = result.deductions.find((d) => d.type === "india_health_education_cess")!;
    expect(tax.amountMinor).toBe(68_750_00);
    expect(cess.amountMinor).toBe(2_750_00);
    expect(result.grossMinor - result.netMinor).toBe(71_500_00);
  });

  it("never produces a negative net across a wide range of salaries", () => {
    for (const annual of [0, 3_00_000_00, 7_00_000_00, 15_00_000_00, 1_00_00_000_00]) {
      const result = computePayrollLine({ ...INDIA_BASE, annualSalaryMinor: annual });
      expect(result.supported).toBe(true);
      if (!result.supported) continue;
      expect(result.netMinor).toBeGreaterThanOrEqual(0);
      expect(result.netMinor).toBeLessThanOrEqual(result.grossMinor);
    }
  });

  it("prorates a partial period the same way as any other jurisdiction", () => {
    const fullYear = computePayrollLine(INDIA_BASE);
    const halfPeriod = computePayrollLine({ ...INDIA_BASE, periodStart: "2024-01-01", periodEnd: "2024-06-30" });
    expect(fullYear.supported && halfPeriod.supported).toBe(true);
    if (!fullYear.supported || !halfPeriod.supported) return;
    expect(halfPeriod.grossMinor).toBeLessThan(fullYear.grossMinor);
    expect(halfPeriod.grossMinor).toBeGreaterThan(0);
  });
});

describe("computeAccrual", () => {
  it("accrues zero at the very start of the period", () => {
    const result = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      asOfDate: "2024-01-01",
    });
    expect(result.accruedGrossMinor).toBeGreaterThan(0); // day 1 itself counts (inclusive)
    expect(result.elapsedDays).toBe(1);
  });

  it("accrues the full period's gross when asOfDate is the period end", () => {
    const result = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      asOfDate: "2024-01-31",
    });
    const fullPeriodGross = computePayrollLine({
      employeeId: "x",
      annualSalaryMinor: 12_000_000,
      currency: "USD",
      jurisdiction: "US-CA",
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
    });
    expect(fullPeriodGross.supported).toBe(true);
    if (!fullPeriodGross.supported) return;
    expect(result.accruedGrossMinor).toBe(fullPeriodGross.grossMinor);
  });

  it("clamps asOfDate outside the period rather than producing a negative or over-100% accrual", () => {
    const before = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-10",
      periodEnd: "2024-01-31",
      asOfDate: "2024-01-01", // before the period even starts
    });
    expect(before.elapsedDays).toBe(1); // clamped to periodStart

    const after = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-10",
      asOfDate: "2024-06-01", // long after the period ends
    });
    expect(after.elapsedDays).toBe(after.periodDays); // clamped to periodEnd, not beyond
  });

  it("accrual increases monotonically as asOfDate advances", () => {
    const early = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      asOfDate: "2024-01-10",
    });
    const later = computeAccrual({
      annualSalaryMinor: 12_000_000,
      periodStart: "2024-01-01",
      periodEnd: "2024-01-31",
      asOfDate: "2024-01-20",
    });
    expect(later.accruedGrossMinor).toBeGreaterThan(early.accruedGrossMinor);
  });
});

describe("computeMaxAdvance", () => {
  it("caps at 50% of accrued gross when nothing has been advanced yet", () => {
    expect(computeMaxAdvance(100_000, 0)).toBe(50_000);
  });

  it("subtracts what has already been advanced", () => {
    expect(computeMaxAdvance(100_000, 30_000)).toBe(20_000);
  });

  it("never goes negative even if prior advances exceed the cap", () => {
    expect(computeMaxAdvance(100_000, 90_000)).toBe(0);
  });
});
