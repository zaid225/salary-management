import { z } from "zod/v4";

// Either an explicit set of employees, or the filters describing a set. The
// filters are stored on the job and re-evaluated per chunk, so a job started
// against "all of Engineering" stays correct even as the roster changes
// underneath it.
export const BulkDeleteBody = z
  .object({
    employeeIds: z.array(z.guid()).max(10_000).optional(),
    country: z.string().length(2).regex(/^[A-Z]{2}$/).optional(),
    department: z.string().min(1).max(100).optional(),
  })
  .refine(
    (v) => (v.employeeIds && v.employeeIds.length > 0) || v.country || v.department,
    "Select employees or provide at least one filter - refusing to terminate the entire roster by accident",
  );
