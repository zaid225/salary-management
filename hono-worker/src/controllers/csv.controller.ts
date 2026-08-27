import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq } from "drizzle-orm";
import Papa from "papaparse";
import type { AppBindings } from "../lib/context.js";
import { employees, salaryRecords } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { writeAudit } from "../models/audit.js";
import { employeeFilterConditions } from "./employees.controller.js";
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

  const scoped = scopedDb(db, orgId);

  for (const batch of chunk(validRows, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const { data } of batch) {
        const existing = await scoped.employees.findByEmployeeNumber(data.employeeNumber);

        if (existing) {
          // Profile fields only - re-importing a roster never silently
          // changes pay; salary changes go through the explicit
          // POST /employees/:id/salary endpoint (design spec §4).
          await tx
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
            .where(eq(employees.id, existing.id));

          await writeAudit(tx, {
            organizationId: orgId,
            actorClerkUserId: userId,
            action: "update",
            entityType: "employee",
            entityId: existing.id,
            before: existing,
            after: data,
          });
          updated++;
        } else {
          const rows = await tx
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
          const inserted = rows[0];
          if (!inserted) throw new Error("employee insert did not return a row");

          await tx.insert(salaryRecords).values({
            organizationId: orgId,
            employeeId: inserted.id,
            amount: data.salary.amount.toFixed(2),
            currency: data.salary.currency,
            effectiveDate: data.salary.effectiveDate,
            reason: "hire",
            createdBy: userId,
          });

          await writeAudit(tx, {
            organizationId: orgId,
            actorClerkUserId: userId,
            action: "create",
            entityType: "employee",
            entityId: inserted.id,
            before: null,
            after: inserted,
          });
          created++;
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

  const csv = Papa.unparse(csvRows);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="employees-export.csv"`);
  return c.body(csv);
}
