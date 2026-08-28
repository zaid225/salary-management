import { z } from "zod/v4";

const CountryCode = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "Country must be an ISO-3166-1 alpha-2 code");
const CurrencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, "Currency must be an ISO-4217 code");
const EmployeeNumber = z
  .string()
  .regex(/^[A-Z]{2,4}-\d{4,6}$/, "Employee number must match e.g. EMP-0001");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const EmployeeProfileFields = z.object({
  employeeNumber: EmployeeNumber,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.email(),
  country: CountryCode,
  department: z.string().min(1).max(100),
  jobTitle: z.string().min(1).max(150),
  level: z.string().min(1).max(20),
  hireDate: IsoDate,
});

export const SalaryFields = z.object({
  amount: z.coerce.number().positive().multipleOf(0.01, "amount must have at most 2 decimal places"),
  currency: CurrencyCode,
  effectiveDate: IsoDate,
  reason: z.enum(["hire", "raise", "adjustment", "correction"]),
});

export const CreateEmployeeSchema = EmployeeProfileFields.extend({
  salary: SalaryFields,
});

export const UpdateEmployeeSchema = EmployeeProfileFields.omit({ employeeNumber: true }).partial();

export const AddSalaryRecordSchema = SalaryFields;

export const EmployeeListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    // Employees allows a larger page than the other lists: an HR manager
    // genuinely does want to see 500 rows at once, and this table is indexed
    // for it. Still clamped, never unbounded.
    .transform((n) => Math.min(Math.max(n ?? 25, 1), 1000)),
  offset: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    .transform((n) => Math.max(n ?? 0, 0)),
  country: CountryCode.optional(),
  department: z.string().optional(),
  status: z.enum(["active", "terminated"]).optional(),
  search: z.string().optional(),
  // Sorting is server-side: the client only ever holds one page, so sorting
  // in the browser would sort that page, not the roster.
  sort: z
    .enum([
      "employeeNumber",
      "firstName",
      "lastName",
      "department",
      "level",
      "country",
      "hireDate",
      "currentSalary",
    ])
    .optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
