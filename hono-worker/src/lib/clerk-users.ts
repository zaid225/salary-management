import { createClerkClient } from "@clerk/backend";
import { inArray, sql } from "drizzle-orm";
import type { CloudflareBindings } from "./context.js";
import type { Db } from "../models/db.js";
import { users } from "../models/schema.js";
import { logger } from "./logger.js";

/**
 * Fills gaps in the local `users` mirror straight from Clerk.
 *
 * The webhook (`POST /webhooks/clerk`) is the steady-state way this table
 * stays in sync, but it only fires on future user.created/user.updated
 * events. Anyone who signed up before the webhook was registered — or while
 * it was misconfigured — has no row, and the UI then falls back to showing a
 * raw Clerk user id instead of a name. This closes that gap on read, so the
 * member list is correct regardless of webhook history.
 *
 * Best-effort by design: a Clerk outage degrades to the ids we already had,
 * never a failed request.
 */
export async function backfillMissingUsers(
  env: CloudflareBindings,
  db: Db,
  clerkUserIds: string[],
): Promise<Map<string, typeof users.$inferSelect>> {
  const known = new Map<string, typeof users.$inferSelect>();
  if (clerkUserIds.length === 0) return known;

  const unique = [...new Set(clerkUserIds)];
  const existing = await db.select().from(users).where(inArray(users.clerkUserId, unique));
  for (const row of existing) known.set(row.clerkUserId, row);

  const missing = unique.filter((id) => !known.has(id));
  if (missing.length === 0 || !env.CLERK_SECRET_KEY) return known;

  try {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const { data } = await clerk.users.getUserList({ userId: missing, limit: missing.length });

    const rows = data.map((u) => ({
      clerkUserId: u.id,
      email: u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? "",
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
      avatarUrl: u.imageUrl ?? null,
    }));
    if (rows.length === 0) return known;

    const saved = await db
      .insert(users)
      .values(rows)
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: {
          email: sqlExcluded("email"),
          name: sqlExcluded("name"),
          avatarUrl: sqlExcluded("avatar_url"),
          updatedAt: new Date(),
        },
      })
      .returning();

    for (const row of saved) known.set(row.clerkUserId, row);
  } catch (err) {
    // Never fail the caller's request over this - the ids still render.
    logger.error({ err: String(err) }, "clerk user backfill failed");
  }

  return known;
}

// Small local helper so the excluded-column references stay readable above.
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
