import { describe, expect, it } from "vitest";
import { computeEquityStrategies, computeVestingSchedule, computeVestWithholding } from "./rsu-optimizer.js";

describe("computeVestingSchedule", () => {
  it("hand-verified: 4,800 shares dividing exactly - 25% cliff, then 36 equal monthly installments", () => {
    const events = computeVestingSchedule({ totalShares: 4_800, vestingStartDate: "2024-01-15" });
    expect(events).toHaveLength(37); // 1 cliff + 36 monthly
    expect(events[0]).toEqual({ monthIndex: 12, vestDate: "2025-01-15", shares: 1_200 });
    // Every monthly installment is exactly 100 shares when it divides evenly.
    expect(events.slice(1).every((e) => e.shares === 100)).toBe(true);
    expect(events[events.length - 1]).toEqual({ monthIndex: 48, vestDate: "2028-01-15", shares: 100 });
    // The sum across every event must equal totalShares exactly - the core invariant.
    expect(events.reduce((sum, e) => sum + e.shares, 0)).toBe(4_800);
  });

  it("hand-verified: 100 shares that do NOT divide evenly - remainder folds into the final month", () => {
    const events = computeVestingSchedule({ totalShares: 100, vestingStartDate: "2024-01-01" });
    expect(events).toHaveLength(37);
    expect(events[0]!.shares).toBe(25); // 25% cliff
    // 75 remaining / 36 months = floor(2.08) = 2/month for the first 35 months.
    expect(events.slice(1, 36).every((e) => e.shares === 2)).toBe(true);
    // 35 months * 2 = 70, so the final month absorbs the remaining 5.
    expect(events[events.length - 1]!.shares).toBe(5);
    expect(events.reduce((sum, e) => sum + e.shares, 0)).toBe(100);
  });

  it("clamps the vest day when the target month is shorter (Jan 31 -> Feb 28/29)", () => {
    const events = computeVestingSchedule({ totalShares: 48, vestingStartDate: "2024-01-31" });
    // Cliff at +12 months: 2025-01-31 (January has 31 days, no clamp needed).
    expect(events[0]!.vestDate).toBe("2025-01-31");
    // +13 months from Jan 31 2024 lands in February 2025 (28 days, 2025 not a leap year).
    const plus13 = events.find((e) => e.monthIndex === 13)!;
    expect(plus13.vestDate).toBe("2025-02-28");
  });
});

describe("computeVestWithholding — US-CA", () => {
  it("hand-verified: 1,000 shares at $50.00/share", () => {
    const result = computeVestWithholding({ sharesVesting: 1_000, fmvPerShareMinor: 5_000, jurisdiction: "US-CA" });
    if (!result.supported) throw new Error("expected supported result");
    // Gross: 1,000 * $50.00 = $50,000.00 = 5,000,000 minor units.
    expect(result.grossValueMinor).toBe(5_000_000);
    // Federal 22% = 1,100,000. CA 10.23% = 511,500. SS 6.2% = 310,000. Medicare 1.45% = 72,500.
    expect(result.withholding).toEqual([
      { type: "federal_income_tax", amountMinor: 1_100_000 },
      { type: "state_income_tax", amountMinor: 511_500 },
      { type: "social_security", amountMinor: 310_000 },
      { type: "medicare", amountMinor: 72_500 },
    ]);
    expect(result.totalTaxMinor).toBe(1_994_000);
    expect(result.netValueMinor).toBe(3_006_000);
  });

  it("returns supported: false for an unimplemented jurisdiction", () => {
    const result = computeVestWithholding({ sharesVesting: 100, fmvPerShareMinor: 1_000, jurisdiction: "IN" });
    expect(result.supported).toBe(false);
  });
});

describe("computeEquityStrategies", () => {
  // Same 1,000-share / $50.00 vest as above: totalTaxMinor = 1,994,000.
  const input = { sharesVesting: 1_000, fmvPerShareMinor: 5_000, totalTaxMinor: 1_994_000 };

  it("hand-verified: sell-to-cover sells just enough whole shares to cover the tax bill", () => {
    const [sellToCover] = computeEquityStrategies(input);
    // ceil(1,994,000 / 5,000) = ceil(398.8) = 399 shares.
    expect(sellToCover!.sharesSold).toBe(399);
    expect(sellToCover!.sharesRetained).toBe(601);
    expect(sellToCover!.cashOutlayMinor).toBe(0);
    // 399 * 5,000 - 1,994,000 = 1,995,000 - 1,994,000 = 1,000 minor units leftover.
    expect(sellToCover!.cashProceedsMinor).toBe(1_000);
    expect(sellToCover!.retainedValueMinor).toBe(3_005_000);
  });

  it("hand-verified: same-day-sale sells everything and nets the full after-tax cash", () => {
    const [, sameDaySale] = computeEquityStrategies(input);
    expect(sameDaySale!.sharesSold).toBe(1_000);
    expect(sameDaySale!.sharesRetained).toBe(0);
    expect(sameDaySale!.cashProceedsMinor).toBe(3_006_000); // matches netValueMinor above
    expect(sameDaySale!.retainedValueMinor).toBe(0);
  });

  it("hand-verified: hold-pay-cash keeps every share but requires the full tax bill in cash", () => {
    const [, , holdPayCash] = computeEquityStrategies(input);
    expect(holdPayCash!.sharesSold).toBe(0);
    expect(holdPayCash!.sharesRetained).toBe(1_000);
    expect(holdPayCash!.cashOutlayMinor).toBe(1_994_000);
    expect(holdPayCash!.retainedValueMinor).toBe(5_000_000);
  });

  it("every strategy's sold + retained shares equals the total vesting", () => {
    for (const s of computeEquityStrategies(input)) {
      expect(s.sharesSold + s.sharesRetained).toBe(input.sharesVesting);
    }
  });
});
