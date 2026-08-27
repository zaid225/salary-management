import { describe, it, expect } from "vitest";
import {
  AddSalaryRecordSchema,
  CreateEmployeeSchema,
  EmployeeListQuery,
  UpdateEmployeeSchema,
} from "./employee.schema.js";
import { PaginationQuery } from "./pagination.schema.js";

// Pure schema tests - no database, no network, no clock. These are the rules
// the API, the CSV importer and the React form all share (design spec §6),
// so they're worth pinning down directly rather than only through a route.

const VALID = {
  employeeNumber: "EMP-0001",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  country: "GB",
  department: "Engineering",
  jobTitle: "Analyst",
  level: "L3",
  hireDate: "2024-01-15",
  salary: { amount: 85000, currency: "GBP", effectiveDate: "2024-01-15", reason: "hire" as const },
};

describe("CreateEmployeeSchema", () => {
  it("accepts a well-formed employee", () => {
    expect(CreateEmployeeSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ["lowercase prefix", "emp-0001"],
    ["too few digits", "EMP-001"],
    ["too many digits", "EMP-1234567"],
    ["no separator", "EMP0001"],
    ["empty", ""],
  ])("rejects an employee number with %s", (_label, employeeNumber) => {
    const result = CreateEmployeeSchema.safeParse({ ...VALID, employeeNumber });
    expect(result.success).toBe(false);
  });

  it("accepts the documented employee-number shapes", () => {
    for (const employeeNumber of ["EM-0001", "EMP-0001", "EMPL-123456"]) {
      expect(CreateEmployeeSchema.safeParse({ ...VALID, employeeNumber }).success).toBe(true);
    }
  });

  it("requires ISO-3166 alpha-2 uppercase for country", () => {
    expect(CreateEmployeeSchema.safeParse({ ...VALID, country: "gb" }).success).toBe(false);
    expect(CreateEmployeeSchema.safeParse({ ...VALID, country: "GBR" }).success).toBe(false);
    expect(CreateEmployeeSchema.safeParse({ ...VALID, country: "GB" }).success).toBe(true);
  });

  it("requires ISO-4217 uppercase for currency", () => {
    const withCurrency = (currency: string) => ({ ...VALID, salary: { ...VALID.salary, currency } });
    expect(CreateEmployeeSchema.safeParse(withCurrency("usd")).success).toBe(false);
    expect(CreateEmployeeSchema.safeParse(withCurrency("US")).success).toBe(false);
    expect(CreateEmployeeSchema.safeParse(withCurrency("USD")).success).toBe(true);
  });

  it("rejects a non-positive salary", () => {
    for (const amount of [0, -1, -85000]) {
      const result = CreateEmployeeSchema.safeParse({ ...VALID, salary: { ...VALID.salary, amount } });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a salary with more than two decimal places", () => {
    const result = CreateEmployeeSchema.safeParse({ ...VALID, salary: { ...VALID.salary, amount: 100.001 } });
    expect(result.success).toBe(false);
    expect(CreateEmployeeSchema.safeParse({ ...VALID, salary: { ...VALID.salary, amount: 100.01 } }).success).toBe(
      true,
    );
  });

  it("coerces a numeric string amount, which is what a CSV cell always is", () => {
    const result = CreateEmployeeSchema.safeParse({
      ...VALID,
      salary: { ...VALID.salary, amount: "85000" as unknown as number },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.salary.amount).toBe(85000);
  });

  it("rejects a malformed date", () => {
    for (const hireDate of ["15-01-2024", "2024/01/15", "2024-1-5", ""]) {
      expect(CreateEmployeeSchema.safeParse({ ...VALID, hireDate }).success).toBe(false);
    }
  });

  it("rejects a malformed email", () => {
    expect(CreateEmployeeSchema.safeParse({ ...VALID, email: "not-an-email" }).success).toBe(false);
  });
});

describe("UpdateEmployeeSchema", () => {
  it("allows a partial patch", () => {
    expect(UpdateEmployeeSchema.safeParse({ department: "Product" }).success).toBe(true);
    expect(UpdateEmployeeSchema.safeParse({}).success).toBe(true);
  });

  it("does not accept employeeNumber - it's the immutable business key", () => {
    const result = UpdateEmployeeSchema.safeParse({ employeeNumber: "EMP-9999" });
    expect(result.success).toBe(true);
    if (result.success) expect("employeeNumber" in result.data).toBe(false);
  });

  it("still enforces field rules on the fields that are present", () => {
    expect(UpdateEmployeeSchema.safeParse({ country: "gb" }).success).toBe(false);
  });
});

describe("AddSalaryRecordSchema", () => {
  it("accepts every documented reason", () => {
    for (const reason of ["hire", "raise", "adjustment", "correction"]) {
      const result = AddSalaryRecordSchema.safeParse({
        amount: 1000,
        currency: "USD",
        effectiveDate: "2024-01-01",
        reason,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown reason", () => {
    const result = AddSalaryRecordSchema.safeParse({
      amount: 1000,
      currency: "USD",
      effectiveDate: "2024-01-01",
      reason: "promotion",
    });
    expect(result.success).toBe(false);
  });
});

describe("pagination", () => {
  it("defaults to limit 25, offset 0", () => {
    expect(PaginationQuery.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it("clamps an over-large limit rather than rejecting it", () => {
    expect(PaginationQuery.parse({ limit: "500" }).limit).toBe(100);
    expect(PaginationQuery.parse({ limit: "1000000" }).limit).toBe(100);
  });

  it("clamps a zero or negative limit up to 1", () => {
    expect(PaginationQuery.parse({ limit: "0" }).limit).toBe(1);
    expect(PaginationQuery.parse({ limit: "-5" }).limit).toBe(1);
  });

  it("falls back to the default on unparseable input instead of 400ing", () => {
    expect(PaginationQuery.parse({ limit: "abc" }).limit).toBe(25);
    expect(PaginationQuery.parse({ offset: "abc" }).offset).toBe(0);
  });

  it("never returns a negative offset", () => {
    expect(PaginationQuery.parse({ offset: "-10" }).offset).toBe(0);
  });

  it("applies the same clamping to the employee list query", () => {
    const parsed = EmployeeListQuery.parse({ limit: "500", country: "US" });
    expect(parsed.limit).toBe(100);
    expect(parsed.country).toBe("US");
  });

  it("rejects an unknown employment status filter", () => {
    expect(EmployeeListQuery.safeParse({ status: "retired" }).success).toBe(false);
  });
});
