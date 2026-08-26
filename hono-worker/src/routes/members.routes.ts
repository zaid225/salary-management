import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { UpdateMembershipRoleBody } from "../schemas/membership.schema.js";
import { listMembers, updateMemberRole, removeMember } from "../controllers/members.controller.js";

export const membersRoutes = new Hono<AppBindings>();

const validatePatchRole = zValidator("json", UpdateMembershipRoleBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

membersRoutes.get("/organizations/:orgId/members", requireAuth, resolveOrg, listMembers);
membersRoutes.patch(
  "/organizations/:orgId/members/:membershipId",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validatePatchRole,
  updateMemberRole,
);
membersRoutes.delete(
  "/organizations/:orgId/members/:membershipId",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  removeMember,
);
