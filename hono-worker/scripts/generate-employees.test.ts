import { describe, it, expect } from "vitest";
import { generateEmployees } from "./generate-employees.js";
import { CreateEmployeeSchema } from "../src/schemas/employee.schema.js";

// No database, no clock, no randomness that isn't seeded - this file runs in
// milliseconds and gives the same answer on every machine.

describe("generateEmployees", () => {
  it("is deterministic for a given seed", () => {
    expect(generateEmployees(50)).toEqual(generateEmployees(50));
  });

  it("produces a different dataset for a different seed", () => {
    expect(generateEmployees(50, 1)).not.toEqual(generateEmployees(50, 2));
  });

  it("produces exactly the requested number of employees", () => {
    expect(generateEmployees(0)).toHaveLength(0);
    expect(generateEmployees(1)).toHaveLength(1);
    expect(generateEmployees(1234)).toHaveLength(1234);
  });

  it("gives every employee a unique employee number", () => {
    const numbers = generateEmployees(2000).map((g) => g.employee.employeeNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("gives every employee a hire record plus zero to two raises", () => {
    for (const g of generateEmployees(300)) {
      expect(g.salaryRecords.length).toBeGreaterThanOrEqual(1);
      expect(g.salaryRecords.length).toBeLessThanOrEqual(3);
      expect(g.salaryRecords[0]?.reason).toBe("hire");
      expect(g.salaryRecords.slice(1).every((r) => r.reason === "raise")).toBe(true);
    }
  });

  it("keeps every salary record in the employee's own country currency", () => {
    for (const g of generateEmployees(300)) {
      const currencies = new Set(g.salaryRecords.map((r) => r.currency));
      expect(currencies.size).toBe(1);
    }
  });

  it("makes each raise larger than the amount before it", () => {
    for (const g of generateEmployees(300)) {
      const amounts = g.salaryRecords.map((r) => Number(r.amount));
      for (let i = 1; i < amounts.length; i++) {
        expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
      }
    }
  });

  it("dates every raise after the hire date", () => {
    for (const g of generateEmployees(300)) {
      const hire = g.salaryRecords[0]!.effectiveDate;
      for (const raise of g.salaryRecords.slice(1)) {
        expect(raise.effectiveDate > hire).toBe(true);
      }
    }
  });

  it("emits amounts with exactly two decimal places, as the numeric column expects", () => {
    for (const g of generateEmployees(200)) {
      for (const r of g.salaryRecords) {
        expect(r.amount).toMatch(/^\d+\.\d{2}$/);
      }
    }
  });

  // The generator feeds both the seed script and the CSV export, so anything
  // it emits has to survive the same validation a hand-entered employee does.
  it("produces rows that pass the API's own schema", () => {
    for (const g of generateEmployees(200)) {
      const hire = g.salaryRecords[0]!;
      const result = CreateEmployeeSchema.safeParse({
        ...g.employee,
        salary: {
          amount: hire.amount,
          currency: hire.currency,
          effectiveDate: hire.effectiveDate,
          reason: "hire",
        },
      });
      if (!result.success) {
        throw new Error(
          `${g.employee.employeeNumber} failed validation: ${result.error.issues[0]?.message ?? "unknown"}`,
        );
      }
    }
  });
});
