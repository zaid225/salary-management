import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, users, invitations, memberships } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { sendInviteEmail } from "../lib/postmark.js";
import type { InviteMemberBody } from "../schemas/invitation.schema.js";
import type { PaginationQuery } from "../schemas/pagination.schema.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function acceptUrl(env: { FRONTEND_URL: string }, token: string): string {
  const origin = env.FRONTEND_URL || "http://localhost:5173";
  return `${origin}/accept-invite/${token}`;
}

type InviteIn = { in: { json: z.input<typeof InviteMemberBody> }; out: { json: z.infer<typeof InviteMemberBody> } };

export async function createInvitation(c: Context<AppBindings, string, InviteIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { email, role } = c.req.valid("json");

  const scoped = scopedDb(db, orgId);
  const existing = await scoped.invitations.findPendingByEmail(email);
  if (existing) {
    return c.json({ invitation: existing, acceptUrl: acceptUrl(c.env, existing.token) }, 200);
  }

  const token = newToken();
  const [invite] = await db
    .insert(invitations)
    .values({
      organizationId: orgId,
      email,
      role,
      token,
      status: "pending",
      invitedBy: userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [inviter] = await db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);

  // Fire-and-forget: response doesn't wait on email delivery.
  c.executionCtx.waitUntil(
    sendInviteEmail(c.env, {
      to: email,
      orgName: org?.name ?? "your organization",
      inviterName: inviter?.name ?? "Someone",
      acceptUrl: acceptUrl(c.env, token),
    }),
  );

  return c.json({ invitation: invite, acceptUrl: acceptUrl(c.env, token) }, 201);
}

type ListInvitationsIn = {
  in: { query: z.input<typeof PaginationQuery> };
  out: { query: z.infer<typeof PaginationQuery> };
};

export async function listInvitations(c: Context<AppBindings, string, ListInvitationsIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const { limit, offset } = c.req.valid("query");

  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending")))
    .limit(limit)
    .offset(offset);

  return c.json({ invitations: rows, limit, offset });
}

// Soft-revoke, consistent with every other delete in this API: the row
// stays for the audit trail, its status flips so the token stops working
// (acceptInvitation's status check rejects it with 410 from then on).
export async function revokeInvitation(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const invitationId = c.req.param("invitationId");

  if (!invitationId) {
    return c.json({ error: { message: "Invitation not found", statusCode: 404 } }, 404);
  }

  const [target] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, orgId)))
    .limit(1);
  if (!target) {
    return c.json({ error: { message: "Invitation not found", statusCode: 404 } }, 404);
  }
  if (target.status !== "pending") {
    return c.json(
      { error: { message: "Only a pending invitation can be revoked", statusCode: 409 } },
      409,
    );
  }

  await db.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, invitationId));
  return c.json({ ok: true });
}

export async function acceptInvitation(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const token = c.req.param("token");
  const userId = c.get("userId")!;

  if (!token) {
    return c.json({ error: { message: "Invitation not found", statusCode: 404 } }, 404);
  }

  try {
    const [invite] = await conn.db.select().from(invitations).where(eq(invitations.token, token)).limit(1);
    if (!invite) {
      return c.json({ error: { message: "Invitation not found", statusCode: 404 } }, 404);
    }
    if (invite.status !== "pending" || invite.expiresAt.getTime() < Date.now()) {
      return c.json({ error: { message: "Invitation is no longer valid", statusCode: 410 } }, 410);
    }

    await conn.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ organizationId: invite.organizationId, clerkUserId: userId, role: invite.role, status: "active" })
        .onConflictDoUpdate({
          target: [memberships.organizationId, memberships.clerkUserId],
          set: { role: invite.role, status: "active" },
        });

      await tx.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invite.id));
    });

    return c.json({ organizationId: invite.organizationId, role: invite.role });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
