import { and, eq } from "drizzle-orm";
import { memberships, invitations } from "./schema.js";
import type { Db } from "./db.js";

// Every organization-scoped query goes through here so the org_id filter
// can never be forgotten in a route handler (design spec §5).
export function scopedDb(db: Db, organizationId: string) {
  return {
    memberships: {
      listActive: () =>
        db
          .select()
          .from(memberships)
          .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, "active"))),

      countActiveAdmins: async (): Promise<number> => {
        const rows = await db
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.status, "active"),
              eq(memberships.role, "admin"),
            ),
          );
        return rows.length;
      },
    },
    invitations: {
      listPending: () =>
        db
          .select()
          .from(invitations)
          .where(and(eq(invitations.organizationId, organizationId), eq(invitations.status, "pending"))),

      findPendingByEmail: async (email: string) => {
        const [row] = await db
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.organizationId, organizationId),
              eq(invitations.email, email),
              eq(invitations.status, "pending"),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    },
  };
}
