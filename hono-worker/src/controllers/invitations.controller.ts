import type { Context } from "hono";
import type { z } from "zod/v4";
import { eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { organizations, users, invitations, memberships } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { sendInviteEmail } from "../lib/postmark.js";
import type { InviteMemberBody } from "../schemas/invitation.schema.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function acceptUrl(env: { ALLOWED_ORIGIN: string }, token: string): string {
  const origin = env.ALLOWED_ORIGIN || "http://localhost:5173";
  return `${origin}/accept-invite/${token}`;
}

type InviteIn = { in: { json: z.input<typeof InviteMemberBody> }; out: { json: z.infer<typeof InviteMemberBody> } };

export async function createInvitation(c: Context<AppBindings, string, InviteIn>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { email, role } = c.req.valid("json");

  try {
    const scoped = scopedDb(conn.db, orgId);
    const existing = await scoped.invitations.findPendingByEmail(email);
    if (existing) {
      return c.json({ invitation: existing, acceptUrl: acceptUrl(c.env, existing.token) }, 200);
    }

    const token = newToken();
    const [invite] = await conn.db
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

    const [org] = await conn.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const [inviter] = await conn.db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);

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
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
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
