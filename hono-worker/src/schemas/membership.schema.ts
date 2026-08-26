import { z } from "zod/v4";

export const UpdateMembershipRoleBody = z.object({
  role: z.enum(["admin", "viewer"]),
});
