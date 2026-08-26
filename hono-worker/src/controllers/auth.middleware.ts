import type { Context, Next } from "hono";
import { verifyToken } from "@clerk/backend";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { memberships } from "../models/schema.js";

const UuidSchema = z.uuid();

// Guards every mutating route unless it's an explicit public
// webhook/ingestion endpoint (api-security.md rule 2). Graceful
// degradation: Clerk unconfigured in dev -> clean 501, never a crash.
export async function requireAuth(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const secretKey = c.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return c.json(
      { error: { message: "Auth not configured", statusCode: 501 } },
      501,
    );
  }

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: { message: "Unauthorized", statusCode: 401 } }, 401);
  }

  try {
    const claims = await verifyToken(token, { secretKey });
    c.set("userId", claims.sub);
  } catch {
    // Never log the token itself - api-security.md rule 3.
    return c.json({ error: { message: "Invalid session token", statusCode: 401 } }, 401);
  }

  await next();
}

// Resolves *which organization* a request acts on, and the caller's role
// in it. Accepts either an X-Org-Id header or a :orgId path param (routes
// like /organizations/:orgId/members carry both, in which case they must
// agree). Org access is authorized here, and only here, against a
// DB-verified active membership row - never trusted from client input
// directly (design spec §5).
export async function resolveOrg(c: Context<AppBindings>, next: Next): Promise<Response | void> {
  const headerOrgId = c.req.header("X-Org-Id");
  const paramOrgId = c.req.param("orgId");
  if (paramOrgId && headerOrgId && paramOrgId !== headerOrgId) {
    return c.json(
      { error: { message: "X-Org-Id header does not match :orgId path param", statusCode: 400 } },
      400,
    );
  }
  const orgId = headerOrgId ?? paramOrgId;
  if (!orgId) {
    return c.json({ error: { message: "X-Org-Id header required", statusCode: 400 } }, 400);
  }
  if (!UuidSchema.safeParse(orgId).success) {
    return c.json({ error: { message: "X-Org-Id must be a valid UUID", statusCode: 400 } }, 400);
  }

  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  try {
    const [membership] = await conn.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, orgId),
          eq(memberships.clerkUserId, c.get("userId") ?? ""),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: { message: "Not a member of this organization", statusCode: 403 } }, 403);
    }

    c.set("orgId", orgId);
    c.set("orgRole", membership.role as "admin" | "viewer");
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }

  await next();
}

export function requireRole(role: "admin") {
  return async (c: Context<AppBindings>, next: Next): Promise<Response | void> => {
    if (c.get("orgRole") !== role) {
      return c.json({ error: { message: "Forbidden", statusCode: 403 } }, 403);
    }
    await next();
  };
}
