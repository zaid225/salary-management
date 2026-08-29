// Deterministic attendance math: pairs raw clock_in/clock_out punches into
// shifts and sums worked hours. Pure function - no I/O, no clock reads - so
// it can be tested directly and trusted the same way payroll-engine.ts is.
export interface Punch {
  type: "clock_in" | "clock_out";
  occurredAt: string; // ISO 8601
}

export interface Shift {
  clockIn: string;
  clockOut: string;
  hours: number;
}

export interface AttendanceResult {
  shifts: Shift[];
  totalHours: number;
  /** Punches that couldn't be paired (e.g. a trailing clock_in with no matching clock_out yet). */
  unpaired: Punch[];
}

/**
 * Pairs punches in chronological order: each clock_in is matched with the
 * next clock_out for the same employee. A clock_in immediately followed by
 * another clock_in (missing punch, forgot to clock out) leaves the first
 * one unpaired rather than guessing at a shift length - an unpaired punch
 * is a data-quality signal to surface, not something to silently estimate.
 */
export function computeAttendance(punches: Punch[]): AttendanceResult {
  const sorted = [...punches].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const shifts: Shift[] = [];
  const unpaired: Punch[] = [];

  let pendingIn: Punch | null = null;
  for (const punch of sorted) {
    if (punch.type === "clock_in") {
      if (pendingIn) unpaired.push(pendingIn); // previous clock_in never got a matching clock_out
      pendingIn = punch;
    } else {
      // clock_out
      if (!pendingIn) {
        unpaired.push(punch); // clock_out with nothing open
        continue;
      }
      const hours = (Date.parse(punch.occurredAt) - Date.parse(pendingIn.occurredAt)) / 3_600_000;
      if (hours >= 0) {
        shifts.push({ clockIn: pendingIn.occurredAt, clockOut: punch.occurredAt, hours });
      } else {
        // clock_out somehow before clock_in (bad data) - flag both rather
        // than recording a negative shift.
        unpaired.push(pendingIn);
        unpaired.push(punch);
      }
      pendingIn = null;
    }
  }
  if (pendingIn) unpaired.push(pendingIn);

  const totalHours = shifts.reduce((sum, s) => sum + s.hours, 0);
  return { shifts, totalHours, unpaired };
}

// A standard US full-time work year - 40 hours/week * 52 weeks. Used as the
// denominator for converting "hours actually worked" into a fraction of a
// full year's salary. Illustrative, like every other constant in this
// domain - a real system needs this configurable per employee/contract.
export const STANDARD_ANNUAL_HOURS = 2_080;

/**
 * Converts actual worked hours into a gross-pay figure, the attendance-based
 * alternative to payroll-engine.ts's calendar-day proration. Used by EWA
 * accrual when real punch data exists for the employee/period; falls back
 * to calendar proration when it doesn't (see ewa.controller.ts).
 */
export function computeHoursBasedGross(annualSalaryMinor: number, hoursWorked: number): number {
  return Math.round(annualSalaryMinor * (hoursWorked / STANDARD_ANNUAL_HOURS));
}
