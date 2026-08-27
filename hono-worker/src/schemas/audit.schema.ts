import { z } from "zod/v4";

export const AuditLogQuery = z.object({
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
  entityType: z.enum(["employee", "salary_record"]).optional(),
  // guid, not uuid: z.uuid() enforces the RFC version/variant nibbles,
  // but a Postgres uuid column accepts any UUID-shaped value (including
  // the all-zeros nil uuid), so the filter must too.
  entityId: z.guid().optional(),
});
