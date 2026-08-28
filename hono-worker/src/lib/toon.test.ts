import { describe, it, expect } from "vitest";
import { toToon } from "./toon.js";

describe("toToon", () => {
  it("encodes a uniform array as one schema header plus pipe-delimited rows", () => {
    const rows = [
      { employeeToken: "a1", amountMinor: 500000, department: "Engineering" },
      { employeeToken: "b2", amountMinor: 620000, department: "Sales" },
    ];
    expect(toToon(rows)).toBe(
      "@schema:employeeToken,amountMinor,department\n" +
        "a1|500000|Engineering\n" +
        "b2|620000|Sales",
    );
  });

  it("returns [] for an empty array", () => {
    expect(toToon([])).toBe("[]");
  });

  it("falls back to JSON for non-uniform rows (different keys)", () => {
    const rows = [{ a: 1, b: 2 }, { a: 1, c: 3 }] as unknown as Record<string, unknown>[];
    expect(toToon(rows)).toBe(JSON.stringify(rows));
  });

  it("falls back to JSON when a value contains the delimiter", () => {
    const rows = [{ note: "spike|anomaly", amount: 100 }];
    expect(toToon(rows)).toBe(JSON.stringify(rows));
  });

  it("renders null/undefined as an empty field rather than the string 'null'", () => {
    const rows = [{ a: 1, b: null, c: undefined }] as unknown as Record<string, unknown>[];
    expect(toToon(rows)).toBe("@schema:a,b,c\n1||");
  });
});
