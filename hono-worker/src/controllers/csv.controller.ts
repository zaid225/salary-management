import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import Papa from "papaparse";
import type { AppBindings } from "../lib/context.js";
import { employees, salaryRecords } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { writeAudit } from "../models/audit.js";
import { employeeFilterConditions, isUniqueViolation } from "./employees.controller.js";
import { CreateEmployeeSchema, type EmployeeListQuery } from "../schemas/employee.schema.js";

interface CsvRow {
  employeeNumber?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  country?: string;
  department?: string;
  jobTitle?: string;
  level?: string;
  hireDate?: string;
  salaryAmount?: string;
  salaryCurrency?: string;
}

const BATCH_SIZE = 500;

// The export's column order, declared once so the header is stable whether
// or not any rows matched the filter.
const EXPORT_COLUMNS = [
  "employeeNumber",
  "firstName",
  "lastName",
  "email",
  "country",
  "department",
  "jobTitle",
  "level",
  "employmentStatus",
  "hireDate",
  "currentSalaryAmount",
  "currentSalaryCurrency",
] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function importEmployeesCsv(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const text = await c.req.text();

  const parsed = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: true });

  let created = 0;
  let updated = 0;
  const failed: { row: number; error: string }[] = [];

  // Validate every row up front against the same CreateEmployeeSchema the
  // JSON API uses (design spec §6, one validation source, three entry
  // points) so a batch's DB work only ever touches well-formed rows.
  const validRows: { row: number; data: z.infer<typeof CreateEmployeeSchema> }[] = [];
  parsed.data.forEach((raw, i) => {
    const rowNumber = i + 1; // 1-indexed data row, header excluded
    const candidate = {
      employeeNumber: raw.employeeNumber ?? "",
      firstName: raw.firstName ?? "",
      lastName: raw.lastName ?? "",
      email: raw.email ?? "",
      country: raw.country ?? "",
      department: raw.department ?? "",
      jobTitle: raw.jobTitle ?? "",
      level: raw.level ?? "",
      hireDate: raw.hireDate ?? "",
      salary: {
        amount: raw.salaryAmount ?? "",
        currency: raw.salaryCurrency ?? "",
        effectiveDate: raw.hireDate ?? "",
        reason: "hire" as const,
      },
    };
    const result = CreateEmployeeSchema.safeParse(candidate);
    if (!result.success) {
      failed.push({ row: rowNumber, error: result.error.issues[0]?.message ?? "Invalid row" });
      return;
    }
    validRows.push({ row: rowNumber, data: result.data });
  });

  for (const batch of chunk(validRows, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const { row, data } of batch) {
        // Each row's DB work runs inside a *nested* transaction on the
        // batch's `tx` handle, which drizzle's postgres-js driver implements
        // as a real Postgres SAVEPOINT. This matters because Postgres marks
        // an entire transaction ABORTED the instant any statement inside it
        // errors - a caught 23505 on row N would otherwise poison every
        // subsequent statement on the shared `tx` (25P02, "current
        // transaction is aborted") and roll back the whole batch, including
        // rows that already succeeded. Per-row savepoints mean a failure
        // only rolls back that row.
        let outcome: "created" | "updated" | undefined;
        try {
          await tx.transaction(async (tx2) => {
            // Look up through `tx2`, not the outer `db` connection: under
            // read-committed isolation a lookup on `db` cannot see a row
            // this same transaction inserted moments earlier, so a
            // same-batch duplicate employeeNumber would race itself into a
            // duplicate insert instead of taking the update branch.
            const [existing] = await tx2
              .select()
              .from(employees)
              .where(
                and(
                  eq(employees.organizationId, orgId),
                  eq(employees.employeeNumber, data.employeeNumber),
                ),
              )
              .limit(1);

            if (existing) {
              // Profile fields only - re-importing a roster never silently
              // changes pay; salary changes go through the explicit
              // POST /employees/:id/salary endpoint (design spec §4).
              const updatedRows = await tx2
                .update(employees)
                .set({
                  firstName: data.firstName,
                  lastName: data.lastName,
                  email: data.email,
                  country: data.country,
                  department: data.department,
                  jobTitle: data.jobTitle,
                  level: data.level,
                  hireDate: data.hireDate,
                  updatedAt: new Date(),
                })
                .where(eq(employees.id, existing.id))
                .returning();
              const after = updatedRows[0];
              if (!after) throw new Error("employee update did not return a row");

              await writeAudit(tx2, {
                organizationId: orgId,
                actorClerkUserId: userId,
                action: "update",
                entityType: "employee",
                entityId: existing.id,
                before: existing,
                after,
              });
              outcome = "updated";
            } else {
              const insertedRows = await tx2
                .insert(employees)
                .values({
                  organizationId: orgId,
                  employeeNumber: data.employeeNumber,
                  firstName: data.firstName,
                  lastName: data.lastName,
                  email: data.email,
                  country: data.country,
                  department: data.department,
                  jobTitle: data.jobTitle,
                  level: data.level,
                  hireDate: data.hireDate,
                })
                .returning();
              const inserted = insertedRows[0];
              if (!inserted) throw new Error("employee insert did not return a row");

              await tx2.insert(salaryRecords).values({
                organizationId: orgId,
                employeeId: inserted.id,
                amount: data.salary.amount.toFixed(2),
                currency: data.salary.currency,
                effectiveDate: data.salary.effectiveDate,
                reason: "hire",
                createdBy: userId,
              });

              await writeAudit(tx2, {
                organizationId: orgId,
                actorClerkUserId: userId,
                action: "create",
                entityType: "employee",
                entityId: inserted.id,
                before: null,
                after: inserted,
              });
              outcome = "created";
            }
          });
          // Only counted once the savepoint has genuinely released.
          if (outcome === "updated") updated++;
          else if (outcome === "created") created++;
        } catch (err) {
          // A true race with a concurrent import hitting the same
          // employeeNumber between the lookup and the insert. The tx-scoped
          // lookup handles the common same-batch case, so this is the
          // defensive fallback. Because the failure rolled back only to this
          // row's savepoint, the outer `tx` stays usable.
          if (isUniqueViolation(err)) {
            failed.push({ row, error: "An employee with this employee number already exists" });
          } else {
            throw err;
          }
        }
      }
    });
  }

  return c.json({ created, updated, failed });
}

type ExportIn = {
  in: { query: z.input<typeof EmployeeListQuery> };
  out: { query: z.infer<typeof EmployeeListQuery> };
};

export async function exportEmployeesCsv(c: Context<AppBindings, string, ExportIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const filters = c.req.valid("query");

  // Export is deliberately unpaginated - it produces the whole filtered
  // view for download in one shot, unlike the list endpoint. Still bounded
  // by whatever filters narrowed it, and it's an explicit user action, not
  // a page a client re-fetches.
  const rows = await db
    .select()
    .from(employees)
    .where(and(...employeeFilterConditions(orgId, filters)));

  const currentSalaries = await scopedDb(db, orgId).salaryRecords.currentFor(rows.map((r) => r.id));

  const csvRows = rows.map((e) => {
    const salary = currentSalaries.get(e.id);
    return {
      employeeNumber: e.employeeNumber,
      firstName: e.firstName,
      lastName: e.lastName,
      email: e.email,
      country: e.country,
      department: e.department,
      jobTitle: e.jobTitle,
      level: e.level,
      employmentStatus: e.employmentStatus,
      hireDate: e.hireDate,
      currentSalaryAmount: salary?.amount ?? "",
      currentSalaryCurrency: salary?.currency ?? "",
    };
  });

  // Pass the field list explicitly rather than letting Papa infer it from
  // the rows: with zero matching employees it would infer nothing and
  // return an empty string, so the download would be a 0-byte file with no
  // header. An empty result should still be a valid CSV - a header row and
  // no data rows.
  const csv = Papa.unparse({ fields: [...EXPORT_COLUMNS], data: csvRows.map((r) => EXPORT_COLUMNS.map((c2) => r[c2])) });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="employees-export.csv"`);
  return c.body(csv);
}
