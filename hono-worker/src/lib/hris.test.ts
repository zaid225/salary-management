import { describe, expect, it } from "vitest";
import { computeAttendance, computeHoursBasedGross, STANDARD_ANNUAL_HOURS, type Punch } from "./hris.js";

describe("computeAttendance", () => {
  it("pairs a single clock_in/clock_out into one 8-hour shift", () => {
    const punches: Punch[] = [
      { type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z" },
      { type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z" },
    ];
    const result = computeAttendance(punches);
    expect(result.shifts).toEqual([
      { clockIn: "2024-06-03T09:00:00.000Z", clockOut: "2024-06-03T17:00:00.000Z", hours: 8 },
    ]);
    expect(result.totalHours).toBe(8);
    expect(result.unpaired).toEqual([]);
  });

  it("sums multiple shifts across days regardless of input order", () => {
    // Deliberately out of chronological order - the function must sort first.
    const punches: Punch[] = [
      { type: "clock_out", occurredAt: "2024-06-04T17:30:00.000Z" },
      { type: "clock_in", occurredAt: "2024-06-04T09:00:00.000Z" },
      { type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z" },
      { type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z" },
    ];
    const result = computeAttendance(punches);
    expect(result.shifts).toHaveLength(2);
    expect(result.totalHours).toBe(8 + 8.5);
    expect(result.unpaired).toEqual([]);
  });

  it("flags a trailing clock_in with no matching clock_out as unpaired", () => {
    const punches: Punch[] = [
      { type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z" },
      { type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z" },
      { type: "clock_in", occurredAt: "2024-06-04T09:00:00.000Z" }, // still open
    ];
    const result = computeAttendance(punches);
    expect(result.shifts).toHaveLength(1);
    expect(result.totalHours).toBe(8);
    expect(result.unpaired).toEqual([{ type: "clock_in", occurredAt: "2024-06-04T09:00:00.000Z" }]);
  });

  it("flags a clock_out with no preceding clock_in as unpaired", () => {
    const punches: Punch[] = [{ type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z" }];
    const result = computeAttendance(punches);
    expect(result.shifts).toEqual([]);
    expect(result.totalHours).toBe(0);
    expect(result.unpaired).toEqual([{ type: "clock_out", occurredAt: "2024-06-03T17:00:00.000Z" }]);
  });

  it("flags a forgotten clock_out - two clock_ins in a row - as an unpaired first punch", () => {
    const punches: Punch[] = [
      { type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z" },
      { type: "clock_in", occurredAt: "2024-06-04T09:00:00.000Z" }, // forgot to clock out on the 3rd
      { type: "clock_out", occurredAt: "2024-06-04T17:00:00.000Z" },
    ];
    const result = computeAttendance(punches);
    expect(result.shifts).toEqual([
      { clockIn: "2024-06-04T09:00:00.000Z", clockOut: "2024-06-04T17:00:00.000Z", hours: 8 },
    ]);
    expect(result.unpaired).toEqual([{ type: "clock_in", occurredAt: "2024-06-03T09:00:00.000Z" }]);
  });

  it("returns zero shifts/hours for an empty punch list", () => {
    const result = computeAttendance([]);
    expect(result).toEqual({ shifts: [], totalHours: 0, unpaired: [] });
  });
});

describe("computeHoursBasedGross", () => {
  it("prorates gross pay by hours worked over the standard annual hours", () => {
    // $104,000.00/yr => $50.00/hr at 2,080 standard hours. 80 hours worked
    // (two full 40-hour weeks) should be exactly $4,000.00.
    expect(STANDARD_ANNUAL_HOURS).toBe(2080);
    const gross = computeHoursBasedGross(104_000_00, 80);
    expect(gross).toBe(4_000_00);
  });

  it("returns 0 for 0 hours worked", () => {
    expect(computeHoursBasedGross(104_000_00, 0)).toBe(0);
  });

  it("rounds to the nearest whole cent", () => {
    // $100,000.00/yr / 2080 = $48.0769.../hr; 1 hour worked rounds to $48.08.
    const gross = computeHoursBasedGross(100_000_00, 1);
    expect(gross).toBe(4808);
  });
});
