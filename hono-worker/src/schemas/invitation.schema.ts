import { z } from "zod/v4";

export const InviteMemberBody = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "viewer"]),
});
