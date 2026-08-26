import { z } from "zod/v4";

export const CreateOrganizationBody = z.object({
  name: z.string().min(1).max(200),
});
