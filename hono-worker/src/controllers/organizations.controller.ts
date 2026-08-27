import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, memberships } from "../models/schema.js";
import { slugify } from "../lib/slug.js";
import type { CreateOrganizationBody } from "../schemas/organization.schema.js";
import type { PaginationQuery } from "../schemas/pagination.schema.js";

type CreateOrgIn = { in: { json: z.input<typeof CreateOrganizationBody> }; out: { json: z.infer<typeof CreateOrganizationBody> } };

export async function createOrganization(c: Context<AppBindings, string, CreateOrgIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const { name } = c.req.valid("json");
  const userId = c.get("userId")!;

  try {
    const base = slugify(name) || "org";
    let slug = base;
    let org: typeof organizations.$inferSelect | undefined;

    // Org insert + admin membership insert must commit together (or not at
    // all) - a crash between them would leave an orphaned org with no admin,
    // which is unrecoverable through the API (design spec §5.6, no
    // super-admin escape hatch). Retry the whole transaction on slug
    // collision so a failed attempt never leaves a partial org committed.
    for (let attempt = 0; attempt < 5 && !org; attempt++) {
      try {
        await conn.db.transaction(async (tx) => {
          const [insertedOrg] = await tx.insert(organizations).values({ name, slug }).returning();
          if (!insertedOrg) throw new Error("organization insert did not return a row");

          await tx.insert(memberships).values({
            organizationId: insertedOrg.id,
            clerkUserId: userId,
            role: "admin",
            status: "active",
          });

          org = insertedOrg;
        });
      } catch {
        slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    if (!org) {
      return c.json(
        { error: { message: "Could not allocate a unique organization slug, try a different name", statusCode: 500 } },
        500,
      );
    }

    return c.json({ organization: org }, 201);
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

type ListOrgsIn = {
  in: { query: z.input<typeof PaginationQuery> };
  out: { query: z.infer<typeof PaginationQuery> };
};

export async function listMyOrganizations(c: Context<AppBindings, string, ListOrgsIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const userId = c.get("userId")!;
  const { limit, offset } = c.req.valid("query");
  try {
    const rows = await conn.db
      .select({ organization: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(and(eq(memberships.clerkUserId, userId), eq(memberships.status, "active")))
      .limit(limit)
      .offset(offset);

    return c.json({ organizations: rows, limit, offset });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
