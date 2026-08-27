import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq, inArray, sql } from "drizzle-orm";
import Papa from "papaparse";
import type { AppBindings } from "../lib/context.js";
import type { Db } from "../models/db.js";
import { employees, salaryRecords } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { writeAudit, writeAuditMany, type WriteAuditParams } from "../models/audit.js";
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

interface ValidRow {
  row: number;
  data: z.infer<typeof CreateEmployeeSchema>;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  // points) so the DB work only ever touches well-formed rows.
  const validRows: ValidRow[] = [];
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
      // A batch is split into waves so no wave repeats an employee number: a
      // multi-row upsert cannot touch the same conflict target twice ("ON
      // CONFLICT DO UPDATE command cannot affect row a second time"), and
      // splitting preserves the create-then-update meaning of a duplicate
      // inside one file. Files without duplicates produce exactly one wave.
      for (const wave of splitIntoWaves(batch)) {
        try {
          const outcome = await importWave(tx, wave, orgId, userId);
          created += outcome.created;
          updated += outcome.updated;
        } catch {
          // The bulk path is all-or-nothing per wave, so fall back to the
          // row-at-a-time path: one bad row is then reported as one bad row
          // rather than taking the whole wave down with it.
          const outcome = await importWaveRowByRow(tx, wave, orgId, userId, failed);
          created += outcome.created;
          updated += outcome.updated;
        }
      }
    });
  }

  return c.json({ created, updated, failed });
}

function splitIntoWaves(batch: ValidRow[]): ValidRow[][] {
  const waves: ValidRow[][] = [];
  const seenPerWave: Set<string>[] = [];

  for (const item of batch) {
    let placed = false;
    for (let w = 0; w < waves.length; w++) {
      if (!seenPerWave[w]!.has(item.data.employeeNumber)) {
        waves[w]!.push(item);
        seenPerWave[w]!.add(item.data.employeeNumber);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push([item]);
      seenPerWave.push(new Set([item.data.employeeNumber]));
    }
  }
  return waves;
}

function profileValues(orgId: string, data: ValidRow["data"]) {
  return {
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
  };
}

// Four queries per wave rather than four per row. At 200 rows that is the
// difference between ~800 sequential round trips to Postgres and ~4, which
// is the whole reason an import of a few hundred rows felt slow.
async function importWave(
  tx: Tx,
  wave: ValidRow[],
  orgId: string,
  userId: string,
): Promise<{ created: number; updated: number }> {
  const numbers = wave.map((r) => r.data.employeeNumber);

  const existing = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.organizationId, orgId), inArray(employees.employeeNumber, numbers)));
  const existingByNumber = new Map(existing.map((e) => [e.employeeNumber, e]));

  const upserted = await tx
    .insert(employees)
    .values(wave.map((r) => profileValues(orgId, r.data)))
    .onConflictDoUpdate({
      target: [employees.organizationId, employees.employeeNumber],
      // Profile fields only - re-importing a roster never silently changes
      // pay; salary changes go through POST /employees/:id/salary
      // (design spec §4).
      set: {
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        email: sql`excluded.email`,
        country: sql`excluded.country`,
        department: sql`excluded.department`,
        jobTitle: sql`excluded.job_title`,
        level: sql`excluded.level`,
        hireDate: sql`excluded.hire_date`,
        updatedAt: new Date(),
      },
    })
    .returning();

  const upsertedByNumber = new Map(upserted.map((e) => [e.employeeNumber, e]));

  const newSalaries: (typeof salaryRecords.$inferInsert)[] = [];
  const auditEntries: WriteAuditParams[] = [];
  let created = 0;
  let updated = 0;

  for (const { data } of wave) {
    const row = upsertedByNumber.get(data.employeeNumber);
    if (!row) continue;
    const before = existingByNumber.get(data.employeeNumber);

    if (before) {
      updated++;
      auditEntries.push({
        organizationId: orgId,
        actorClerkUserId: userId,
        action: "update",
        entityType: "employee",
        entityId: row.id,
        before,
        after: row,
      });
    } else {
      created++;
      newSalaries.push({
        organizationId: orgId,
        employeeId: row.id,
        amount: data.salary.amount.toFixed(2),
        currency: data.salary.currency,
        effectiveDate: data.salary.effectiveDate,
        reason: "hire",
        createdBy: userId,
      });
      auditEntries.push({
        organizationId: orgId,
        actorClerkUserId: userId,
        action: "create",
        entityType: "employee",
        entityId: row.id,
        before: null,
        after: row,
      });
    }
  }

  if (newSalaries.length > 0) await tx.insert(salaryRecords).values(newSalaries);
  if (auditEntries.length > 0) await writeAuditMany(tx, auditEntries);

  return { created, updated };
}

// The row-at-a-time path, kept as the fallback: each row runs in its own
// savepoint, so a genuine unique-violation is reported against that row and
// leaves the rest of the wave intact.
async function importWaveRowByRow(
  tx: Tx,
  wave: ValidRow[],
  orgId: string,
  userId: string,
  failed: { row: number; error: string }[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const { row, data } of wave) {
    let outcome: "created" | "updated" | undefined;
    try {
      await tx.transaction(async (tx2) => {
        const [existing] = await tx2
          .select()
          .from(employees)
          .where(
            and(eq(employees.organizationId, orgId), eq(employees.employeeNumber, data.employeeNumber)),
          )
          .limit(1);

        if (existing) {
          const rows = await tx2
            .update(employees)
            .set({ ...profileValues(orgId, data), updatedAt: new Date() })
            .where(eq(employees.id, existing.id))
            .returning();
          const after = rows[0];
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
          const rows = await tx2.insert(employees).values(profileValues(orgId, data)).returning();
          const inserted = rows[0];
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
      if (outcome === "updated") updated++;
      else if (outcome === "created") created++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        failed.push({ row, error: "An employee with this employee number already exists" });
      } else {
        throw err;
      }
    }
  }

  return { created, updated };
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
  const csv = Papa.unparse({
    fields: [...EXPORT_COLUMNS],
    data: csvRows.map((r) => EXPORT_COLUMNS.map((c2) => r[c2])),
  });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="employees-export.csv"`);
  return c.body(csv);
}
