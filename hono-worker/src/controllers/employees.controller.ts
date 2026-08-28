import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { employees, fxRates, salaryRecords } from "../models/schema.js";
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
    const term = `%${f.search}%`;
    conditions.push(
      or(
        ilike(employees.firstName, term),
        ilike(employees.lastName, term),
        ilike(employees.employeeNumber, term),
        ilike(employees.email, term),
        // Searching the columns separately means "Casey Lee" matches nothing,
        // because no single column holds both halves of a name - which is the
        // most natural thing for someone to type.
        sql`(${employees.firstName} || ' ' || ${employees.lastName}) ILIKE ${term}`,
      )!,
    );
  }
  return conditions;
}

// Only these columns are sortable, and the mapping is explicit - a column
// name is never interpolated into SQL from the query string.
const SORTABLE = {
  employeeNumber: employees.employeeNumber,
  firstName: employees.firstName,
  lastName: employees.lastName,
  department: employees.department,
  level: employees.level,
  country: employees.country,
  hireDate: employees.hireDate,
} as const;

export async function listEmployees(c: Context<AppBindings, string, ListIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const filters = c.req.valid("query");
  const { limit, offset, sort, order } = filters;

  // employeeNumber ascending is a stable, meaningful default; without an
  // explicit ORDER BY, Postgres may return pages in overlapping orders and
  // rows appear to jump between pages.
  const direction = order === "desc" ? desc : asc;

  // Current salary is not a column on this table - it is the latest
  // salary_records row per employee - so sorting by it needs a correlated
  // lookup. Normalized to USD so a GBP salary sorts against a USD one
  // meaningfully; rows whose currency has no rate sort last rather than
  // being treated as if the rate were 1.
  const currentSalaryUsd = sql`(
    SELECT sr.amount * fx.rate_to_usd
    FROM salary_records sr
    JOIN fx_rates fx ON fx.currency = sr.currency
    WHERE sr.employee_id = ${employees.id}
    ORDER BY sr.effective_date DESC
    LIMIT 1
  )`;

  const orderExpression =
    sort === "currentSalary"
      ? order === "desc"
        ? sql`${currentSalaryUsd} DESC NULLS LAST`
        : sql`${currentSalaryUsd} ASC NULLS LAST`
      : direction(SORTABLE[sort ?? "employeeNumber"]);

  const rows = await db
    .select()
    .from(employees)
    .where(and(...employeeFilterConditions(orgId, filters)))
    .orderBy(orderExpression, asc(employees.id))
    .limit(limit)
    .offset(offset);

  const currentSalaries = await scopedDb(db, orgId).salaryRecords.currentFor(rows.map((r) => r.id));

  // The total is what lets the UI offer "select all N matching" rather than
  // only the rows currently on screen, and gives pagination a real end.
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(employees)
    .where(and(...employeeFilterConditions(orgId, filters)));

  return c.json({
    employees: rows.map((e) => ({ ...e, currentSalary: currentSalaries.get(e.id) ?? null })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
}

/**
 * The distinct values that actually exist in this organization, so the UI can
 * offer a dropdown instead of a free-text box that silently creates
 * "Enginering" alongside "Engineering". Currencies come from fx_rates rather
 * than from salaries: offering one we cannot convert would put the employee
 * straight into the dashboard's excluded pile.
 */
export async function getEmployeeFacets(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;

  const [departments, countries, levels, currencies] = await Promise.all([
    db
      .selectDistinct({ value: employees.department })
      .from(employees)
      .where(eq(employees.organizationId, orgId))
      .orderBy(asc(employees.department)),
    db
      .selectDistinct({ value: employees.country })
      .from(employees)
      .where(eq(employees.organizationId, orgId))
      .orderBy(asc(employees.country)),
    db
      .selectDistinct({ value: employees.level })
      .from(employees)
      .where(eq(employees.organizationId, orgId))
      .orderBy(asc(employees.level)),
    db.select({ value: fxRates.currency }).from(fxRates).orderBy(asc(fxRates.currency)),
  ]);

  return c.json({
    departments: departments.map((r) => r.value),
    countries: countries.map((r) => r.value),
    levels: levels.map((r) => r.value),
    currencies: currencies.map((r) => r.value),
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
