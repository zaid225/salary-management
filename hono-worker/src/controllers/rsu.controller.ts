import type { Context } from "hono";
import type { z } from "zod/v4";
import type { AppBindings } from "../lib/context.js";
import { computeEquityStrategies, computeVestingSchedule, computeVestWithholding } from "../lib/rsu-optimizer.js";
import type { VestingScheduleBody, VestCalculatorBody } from "../schemas/payroll.schema.js";

type ScheduleIn = {
  in: { json: z.input<typeof VestingScheduleBody> };
  out: { json: z.infer<typeof VestingScheduleBody> };
};

/** Pure, stateless - no DB read/write. Rule #1: no AI anywhere in this path. */
export function getVestingSchedule(c: Context<AppBindings, string, ScheduleIn>): Response {
  const { totalShares, vestingStartDate } = c.req.valid("json");
  const events = computeVestingSchedule({ totalShares, vestingStartDate });
  return c.json({ events });
}

type CalculatorIn = {
  in: { json: z.input<typeof VestCalculatorBody> };
  out: { json: z.infer<typeof VestCalculatorBody> };
};

/**
 * The "optimizer": deterministic vest-tax withholding plus all three
 * standard strategies for covering it, computed exactly - never a model
 * recommending one. Pure, stateless, no DB read/write.
 */
export function getVestCalculator(c: Context<AppBindings, string, CalculatorIn>): Response {
  const { sharesVesting, fmvPerShareMinor, jurisdiction } = c.req.valid("json");
  const tax = computeVestWithholding({ sharesVesting, fmvPerShareMinor, jurisdiction });
  if (!tax.supported) {
    return c.json({ error: { message: tax.reason, statusCode: 400 } }, 400);
  }
  const strategies = computeEquityStrategies({ sharesVesting, fmvPerShareMinor, totalTaxMinor: tax.totalTaxMinor });
  return c.json({ tax, strategies });
}
