import { and, desc, eq, inArray } from "drizzle-orm";
import { memberships, invitations, employees, salaryRecords, auditLog } from "./schema.js";
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
    employees: {
      list: (opts: { limit: number; offset: number }) =>
        db
          .select()
          .from(employees)
          .where(and(eq(employees.organizationId, organizationId), eq(employees.employmentStatus, "active")))
          .limit(opts.limit)
          .offset(opts.offset),

      getById: async (id: string) => {
        const [row] = await db
          .select()
          .from(employees)
          .where(and(eq(employees.id, id), eq(employees.organizationId, organizationId)))
          .limit(1);
        return row ?? null;
      },

      findByEmployeeNumber: async (employeeNumber: string) => {
        const [row] = await db
          .select()
          .from(employees)
          .where(
            and(
              eq(employees.organizationId, organizationId),
              eq(employees.employeeNumber, employeeNumber),
            ),
          )
          .limit(1);
        return row ?? null;
      },
    },
    salaryRecords: {
      historyFor: (employeeId: string) =>
        db
          .select()
          .from(salaryRecords)
          .where(
            and(
              eq(salaryRecords.organizationId, organizationId),
              eq(salaryRecords.employeeId, employeeId),
            ),
          )
          .orderBy(desc(salaryRecords.effectiveDate)),

      // Batched, not N+1: one query for however many employee ids are
      // passed, using selectDistinctOn to pick each employee's latest row
      // by effective_date (design spec §3 - "current salary" is never a
      // mutated column).
      currentFor: async (employeeIds: string[]): Promise<Map<string, typeof salaryRecords.$inferSelect>> => {
        if (employeeIds.length === 0) return new Map();
        const rows = await db
          .selectDistinctOn([salaryRecords.employeeId])
          .from(salaryRecords)
          .where(
            and(
              eq(salaryRecords.organizationId, organizationId),
              inArray(salaryRecords.employeeId, employeeIds),
            ),
          )
          .orderBy(salaryRecords.employeeId, desc(salaryRecords.effectiveDate));
        return new Map(rows.map((r) => [r.employeeId, r]));
      },
    },
    auditLog: {
      list: (opts: { limit: number; offset: number; entityType?: string; entityId?: string }) => {
        const conditions = [eq(auditLog.organizationId, organizationId)];
        if (opts.entityType) conditions.push(eq(auditLog.entityType, opts.entityType));
        if (opts.entityId) conditions.push(eq(auditLog.entityId, opts.entityId));
        return db
          .select()
          .from(auditLog)
          .where(and(...conditions))
          .orderBy(desc(auditLog.createdAt))
          .limit(opts.limit)
          .offset(opts.offset);
      },
    },
  };
}
