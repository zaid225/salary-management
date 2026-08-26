import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, memberships } from "../models/schema.js";
import { slugify } from "../lib/slug.js";
import type { CreateOrganizationBody } from "../schemas/organization.schema.js";

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

    for (let attempt = 0; attempt < 5 && !org; attempt++) {
      try {
        [org] = await conn.db.insert(organizations).values({ name, slug }).returning();
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

    await conn.db.insert(memberships).values({
      organizationId: org.id,
      clerkUserId: userId,
      role: "admin",
      status: "active",
    });

    return c.json({ organization: org }, 201);
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function listMyOrganizations(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const userId = c.get("userId")!;
  try {
    const rows = await conn.db
      .select({ organization: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(and(eq(memberships.clerkUserId, userId), eq(memberships.status, "active")));

    return c.json({ organizations: rows });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
