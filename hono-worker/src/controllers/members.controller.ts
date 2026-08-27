import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { memberships, users } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import type { UpdateMembershipRoleBody } from "../schemas/membership.schema.js";
import type { PaginationQuery } from "../schemas/pagination.schema.js";

type ListMembersIn = {
  in: { query: z.input<typeof PaginationQuery> };
  out: { query: z.infer<typeof PaginationQuery> };
};

export async function listMembers(c: Context<AppBindings, string, ListMembersIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const { limit, offset } = c.req.valid("query");

  const rows = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .leftJoin(users, eq(memberships.clerkUserId, users.clerkUserId))
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")))
    .limit(limit)
    .offset(offset);

  return c.json({ members: rows, limit, offset });
}

type PatchRoleIn = {
  in: { json: z.input<typeof UpdateMembershipRoleBody> };
  out: { json: z.infer<typeof UpdateMembershipRoleBody> };
};

export async function updateMemberRole(c: Context<AppBindings, string, PatchRoleIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");
  const { role } = c.req.valid("json");

  if (!membershipId) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  const [target] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
    .limit(1);
  if (!target) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  if (target.role === "admin" && role !== "admin") {
    const adminCount = await scopedDb(db, orgId).memberships.countActiveAdmins();
    if (adminCount <= 1) {
      return c.json(
        { error: { message: "Organization must have at least one admin", statusCode: 409 } },
        409,
      );
    }
  }

  await db.update(memberships).set({ role }).where(eq(memberships.id, membershipId));
  return c.json({ ok: true });
}

export async function removeMember(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const membershipId = c.req.param("membershipId");

  if (!membershipId) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  const [target] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, orgId)))
    .limit(1);
  if (!target) {
    return c.json({ error: { message: "Membership not found", statusCode: 404 } }, 404);
  }

  if (target.role === "admin") {
    const adminCount = await scopedDb(db, orgId).memberships.countActiveAdmins();
    if (adminCount <= 1) {
      return c.json(
        { error: { message: "Organization must have at least one admin", statusCode: 409 } },
        409,
      );
    }
  }

  await db.update(memberships).set({ status: "removed" }).where(eq(memberships.id, membershipId));
  return c.json({ ok: true });
}
