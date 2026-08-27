import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, eq, ilike, or } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { employees, salaryRecords } from "../models/schema.js";
import { scopedDb } from "../models/scoped-db.js";
import { writeAudit } from "../models/audit.js";
import type {
  AddSalaryRecordSchema,
  CreateEmployeeSchema,
  EmployeeListQuery,
  UpdateEmployeeSchema,
} from "../schemas/employee.schema.js";

type ListIn = {
  in: { query: z.input<typeof EmployeeListQuery> };
  out: { query: z.infer<typeof EmployeeListQuery> };
};

type EmployeeFilters = z.infer<typeof EmployeeListQuery>;

// Shared by the list endpoint and the CSV export so a filtered download can
// never drift from the filtered view it was exported from.
export function employeeFilterConditions(orgId: string, f: Partial<EmployeeFilters>) {
  const conditions = [
    eq(employees.organizationId, orgId),
    // Terminated employees are hidden unless explicitly asked for, matching
    // the soft-delete convention memberships.listActive already sets.
    eq(employees.employmentStatus, f.status ?? "active"),
  ];
  if (f.country) conditions.push(eq(employees.country, f.country));
  if (f.department) conditions.push(eq(employees.department, f.department));
  if (f.search) {
    conditions.push(
      or(
        ilike(employees.firstName, `%${f.search}%`),
        ilike(employees.lastName, `%${f.search}%`),
        ilike(employees.employeeNumber, `%${f.search}%`),
      )!,
    );
  }
  return conditions;
}

export async function listEmployees(c: Context<AppBindings, string, ListIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const filters = c.req.valid("query");
  const { limit, offset } = filters;

  const rows = await db
    .select()
    .from(employees)
    .where(and(...employeeFilterConditions(orgId, filters)))
    .limit(limit)
    .offset(offset);

  const currentSalaries = await scopedDb(db, orgId).salaryRecords.currentFor(rows.map((r) => r.id));

  return c.json({
    employees: rows.map((e) => ({ ...e, currentSalary: currentSalaries.get(e.id) ?? null })),
    limit,
    offset,
  });
}

export async function getEmployee(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const scoped = scopedDb(db, orgId);
  const employee = await scoped.employees.getById(id);
  if (!employee) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const salaryHistory = await scoped.salaryRecords.historyFor(id);
  return c.json({ employee, salaryHistory });
}

type CreateIn = {
  in: { json: z.input<typeof CreateEmployeeSchema> };
  out: { json: z.infer<typeof CreateEmployeeSchema> };
};

export async function createEmployee(c: Context<AppBindings, string, CreateIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { salary, ...profile } = c.req.valid("json");

  try {
    let created: typeof employees.$inferSelect | undefined;
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(employees)
        .values({ ...profile, organizationId: orgId })
        .returning();
      const employee = rows[0];
      if (!employee) throw new Error("employee insert did not return a row");

      await tx.insert(salaryRecords).values({
        organizationId: orgId,
        employeeId: employee.id,
        amount: salary.amount.toFixed(2),
        currency: salary.currency,
        effectiveDate: salary.effectiveDate,
        reason: salary.reason,
        createdBy: userId,
      });

      await writeAudit(tx, {
        organizationId: orgId,
        actorClerkUserId: userId,
        action: "create",
        entityType: "employee",
        entityId: employee.id,
        before: null,
        after: employee,
      });

      created = employee;
    });

    return c.json({ employee: created }, 201);
  } catch (err) {
    // Unique-violation on (organization_id, employee_number) - a clean 409,
    // not a generic 500 (error-handling-logging.md rule 4).
    if (isUniqueViolation(err)) {
      return c.json(
        { error: { message: "An employee with this employee number already exists", statusCode: 409 } },
        409,
      );
    }
    throw err;
  }
}

// postgres-js surfaces the SQLSTATE on the error itself, but a failure
// inside db.transaction() can arrive wrapped, so check the cause too.
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "23505") return true;
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code === "23505";
}

type UpdateIn = {
  in: { json: z.input<typeof UpdateEmployeeSchema> };
  out: { json: z.infer<typeof UpdateEmployeeSchema> };
};

export async function updateEmployee(c: Context<AppBindings, string, UpdateIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const id = c.req.param("id");
  const patch = c.req.valid("json");

  if (!id) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const before = await scopedDb(db, orgId).employees.getById(id);
  if (!before) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  let after: typeof employees.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(employees)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(employees.id, id), eq(employees.organizationId, orgId)))
      .returning();
    after = rows[0];
    if (!after) throw new Error("update did not return a row");

    await writeAudit(tx, {
      organizationId: orgId,
      actorClerkUserId: userId,
      action: "update",
      entityType: "employee",
      entityId: id,
      before,
      after,
    });
  });

  return c.json({ employee: after });
}

export async function deleteEmployee(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const id = c.req.param("id");

  if (!id) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const before = await scopedDb(db, orgId).employees.getById(id);
  if (!before) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  await db.transaction(async (tx) => {
    // Soft delete: the salary history stays readable for analytics/audit.
    await tx
      .update(employees)
      .set({ employmentStatus: "terminated", updatedAt: new Date() })
      .where(and(eq(employees.id, id), eq(employees.organizationId, orgId)));

    await writeAudit(tx, {
      organizationId: orgId,
      actorClerkUserId: userId,
      action: "delete",
      entityType: "employee",
      entityId: id,
      before,
      after: { ...before, employmentStatus: "terminated" },
    });
  });

  return c.json({ ok: true });
}

type AddSalaryIn = {
  in: { json: z.input<typeof AddSalaryRecordSchema> };
  out: { json: z.infer<typeof AddSalaryRecordSchema> };
};

export async function addSalaryRecord(c: Context<AppBindings, string, AddSalaryIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const employeeId = c.req.param("id");
  const { amount, currency, effectiveDate, reason } = c.req.valid("json");

  if (!employeeId) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  const employee = await scopedDb(db, orgId).employees.getById(employeeId);
  if (!employee) {
    return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);
  }

  let created: typeof salaryRecords.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const rows = await tx
      .insert(salaryRecords)
      .values({
        organizationId: orgId,
        employeeId,
        amount: amount.toFixed(2),
        currency,
        effectiveDate,
        reason,
        createdBy: userId,
      })
      .returning();
    created = rows[0];
    if (!created) throw new Error("salary record insert did not return a row");

    await writeAudit(tx, {
      organizationId: orgId,
      actorClerkUserId: userId,
      action: "create",
      entityType: "salary_record",
      entityId: created.id,
      before: null,
      after: created,
    });
  });

  return c.json({ salaryRecord: created }, 201);
}
