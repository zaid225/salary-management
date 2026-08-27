import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { AppBindings } from "../lib/context.js";
import { requireAuth } from "../controllers/auth.middleware.js";
import { CreateOrganizationBody } from "../schemas/organization.schema.js";
import { PaginationQuery } from "../schemas/pagination.schema.js";
import { validateQuery } from "../lib/validate.js";
import { createOrganization, listMyOrganizations } from "../controllers/organizations.controller.js";

export const organizationsRoutes = new Hono<AppBindings>();

const validateCreateOrg = zValidator("json", CreateOrganizationBody, (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { message: result.error.issues[0]?.message ?? "Invalid request body", statusCode: 400 } },
      400,
    );
  }
});

organizationsRoutes.post("/organizations", requireAuth, validateCreateOrg, createOrganization);
organizationsRoutes.get("/organizations", requireAuth, validateQuery(PaginationQuery), listMyOrganizations);
