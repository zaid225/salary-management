import { z } from "zod/v4";

// limit is clamped to [1, 100], never rejected for being too large -
// design spec §4: "requests above the max are clamped, not rejected".
// A missing or unparseable value falls back to the default instead of
// 400ing, for the same reason: a list endpoint should still list.
export const PaginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    .transform((n) => Math.min(Math.max(n ?? 25, 1), 100)),
  offset: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    .transform((n) => Math.max(n ?? 0, 0)),
});
