import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq, sql } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, users, invitations, memberships } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { sendInviteEmail } from "../lib/postmark.js";
import type { InviteMemberBody } from "../schemas/invitation.schema.js";
import type { PaginationQuery } from "../schemas/pagination.schema.js";
import { backfillMissingUsers } from "../lib/clerk-users.js";

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

  // Self-invite guard: an admin's own email, case-insensitively - inviting
  // yourself has no legitimate use here (you're already whatever role you
  // already have) and only invites confusion via the accept flow's
  // onConflictDoUpdate silently changing your own membership row.
  const [inviterUser] = await db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);
  if (inviterUser && inviterUser.email.toLowerCase() === email.toLowerCase()) {
    return c.json({ error: { message: "You can't invite yourself", statusCode: 400 } }, 400);
  }

  // Already-a-member guard: an email that already belongs to an ACTIVE
  // member of this org shouldn't get a fresh invite at all - promoting or
  // demoting an existing member is what the member-role endpoint is for
  // (members.controller.ts), not a re-invite. A former member (status
  // 'removed') can still be re-invited - only an active membership blocks this.
  const [existingMember] = await db
    .select({ membershipId: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.clerkUserId, memberships.clerkUserId))
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.status, "active"),
        sql`lower(${users.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  if (existingMember) {
    return c.json(
      { error: { message: "This email already belongs to a member of this organization", statusCode: 409 } },
      409,
    );
  }

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
  // Same self-healing lookup the member list uses: without it the invite
  // email goes out as "Someone invited you" whenever the webhook has not
  // populated this user yet.
  const inviter = (await backfillMissingUsers(c.env, db, [userId])).get(userId);

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

    // Invites are for onboarding a NEW member into the org - accepting one
    // must never change the role of someone who's already an active member
    // (self-invited-at-a-lower-role, or a stale invite issued before a role
    // change already caught up with them). That's what the dedicated
    // role-change endpoint is for (members.controller.ts), which already
    // guards against leaving an org with zero admins - this path used to
    // bypass that guard entirely via a blind onConflictDoUpdate, and did:
    // a sole admin who accepted a self-issued viewer invite got silently
    // downgraded to viewer with no admin left to undo it.
    const [existingActive] = await conn.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, invite.organizationId),
          eq(memberships.clerkUserId, userId),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);

    if (existingActive) {
      await conn.db.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invite.id));
      return c.json({ organizationId: invite.organizationId, role: existingActive.role });
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
