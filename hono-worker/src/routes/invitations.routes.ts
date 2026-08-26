import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { rateLimitByOrg } from "../controllers/rate-limit.middleware.js";
import { InviteMemberBody } from "../schemas/invitation.schema.js";
import { createInvitation, acceptInvitation } from "../controllers/invitations.controller.js";

export const invitationsRoutes = new Hono<AppBindings>();

const validateInvite = zValidator("json", InviteMemberBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

invitationsRoutes.post(
  "/organizations/:orgId/invitations",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  rateLimitByOrg(20, 3600),
  validateInvite,
  createInvitation,
);
invitationsRoutes.post("/invitations/:token/accept", requireAuth, acceptInvitation);
