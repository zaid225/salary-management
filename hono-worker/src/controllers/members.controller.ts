import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { memberships, users } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import type { UpdateMembershipRoleBody } from "../schemas/membership.schema.js";

export async function listMembers(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  try {
    const rows = await conn.db
      .select({ membership: memberships, user: users })
      .from(memberships)
      .leftJoin(users, eq(memberships.clerkUserId, users.clerkUserId))
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")));

    return c.json({ members: rows });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

type PatchRoleIn = {
  in: { json: z.input<typeof UpdateMembershipRoleBody> };
  out: { json: z.infer<typeof UpdateMembershipRoleBody> };
};

export async function updateMemberRole(c: Context<AppBindings, string, PatchRoleIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");
  const { role } = c.req.valid("json");

  if (!membershipId) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  try {
    const [target] = await conn.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) {
      return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
    }

    if (target.role === "admin" && role !== "admin") {
      const adminCount = await scopedDb(conn.db, orgId).memberships.countActiveAdmins();
      if (adminCount <= 1) {
        return c.json(
          { error: { message: "Organization must have at least one admin", statusCode: 409 } },
          409,
        );
      }
    }

    await conn.db.update(memberships).set({ role }).where(eq(memberships.id, membershipId));
    return c.json({ ok: true });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function removeMember(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");

  if (!membershipId) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  try {
    const [target] = await conn.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
      .limit(1);
    if (!target) {
      return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
    }

    if (target.role === "admin") {
      const adminCount = await scopedDb(conn.db, orgId).memberships.countActiveAdmins();
      if (adminCount <= 1) {
        return c.json(
          { error: { message: "Organization must have at least one admin", statusCode: 409 } },
          409,
        );
      }
    }

    await conn.db.update(memberships).set({ status: "removed" }).where(eq(memberships.id, membershipId));
    return c.json({ ok: true });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
