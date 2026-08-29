import { describe, expect, it } from "vitest";
import { computeTreasuryForecast } from "./treasury-forecast.js";

describe("computeTreasuryForecast", () => {
  it("hand-verified: a healthy balance stays healthy after known and pending obligations", () => {
    // $500,000 balance - $200,000 known payroll - $10,000 pending EWA = $290,000.
    // Then stress: - $50,000 potential additional EWA = $240,000. Both positive.
    const result = computeTreasuryForecast({
      startingCashBalanceMinor: 500_000_00,
      knownObligationsMinor: 200_000_00,
      pendingEwaMinor: 10_000_00,
      potentialAdditionalEwaMinor: 50_000_00,
    });
    expect(result.projectedBalanceMinor).toBe(290_000_00);
    expect(result.stressTestBalanceMinor).toBe(240_000_00);
    expect(result.shortfallMinor).toBe(0);
    expect(result.stressShortfallMinor).toBe(0);
    expect(result.atRisk).toBe(false);
    expect(result.stressAtRisk).toBe(false);
  });

  it("hand-verified: known obligations alone push the projected balance negative", () => {
    // $100,000 balance - $150,000 known payroll - $0 pending = -$50,000.
    const result = computeTreasuryForecast({
      startingCashBalanceMinor: 100_000_00,
      knownObligationsMinor: 150_000_00,
      pendingEwaMinor: 0,
      potentialAdditionalEwaMinor: 0,
    });
    expect(result.projectedBalanceMinor).toBe(-50_000_00);
    expect(result.shortfallMinor).toBe(50_000_00);
    expect(result.atRisk).toBe(true);
    // No further EWA headroom to stress-test - stress result equals the base result.
    expect(result.stressTestBalanceMinor).toBe(-50_000_00);
    expect(result.stressAtRisk).toBe(true);
  });

  it("hand-verified: only the stress scenario goes negative, the base projection stays positive", () => {
    // $100,000 balance - $80,000 known - $5,000 pending = $15,000 (healthy).
    // Stress: - $20,000 potential additional EWA = -$5,000 (at risk).
    const result = computeTreasuryForecast({
      startingCashBalanceMinor: 100_000_00,
      knownObligationsMinor: 80_000_00,
      pendingEwaMinor: 5_000_00,
      potentialAdditionalEwaMinor: 20_000_00,
    });
    expect(result.projectedBalanceMinor).toBe(15_000_00);
    expect(result.atRisk).toBe(false);
    expect(result.stressTestBalanceMinor).toBe(-5_000_00);
    expect(result.stressShortfallMinor).toBe(5_000_00);
    expect(result.stressAtRisk).toBe(true);
  });

  it("all-zero inputs produce an exact zero balance, not at risk", () => {
    const result = computeTreasuryForecast({
      startingCashBalanceMinor: 0,
      knownObligationsMinor: 0,
      pendingEwaMinor: 0,
      potentialAdditionalEwaMinor: 0,
    });
    expect(result.projectedBalanceMinor).toBe(0);
    expect(result.atRisk).toBe(false); // 0 is not < 0
    expect(result.stressAtRisk).toBe(false);
  });
});
