import { writeFileSync } from "node:fs";
import { generateEmployees } from "./generate-employees.js";

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code?: number): never };

// Writes a CSV in exactly the shape POST /employees/import expects, using
// the same deterministic generator the seed script uses - so the file is
// reproducible and its salary bands are country-appropriate rather than
// uniform noise.
//
//   npm run csv:generate                    -> 10000 rows, employees.csv
//   npm run csv:generate -- 500 sample.csv  -> 500 rows, sample.csv

const HEADER = [
  "employeeNumber",
  "firstName",
  "lastName",
  "email",
  "country",
  "department",
  "jobTitle",
  "level",
  "hireDate",
  "salaryAmount",
  "salaryCurrency",
];

function escapeCell(value: string): string {
  // Job titles and names are generated from a fixed word list here, but an
  // import format that only works for comma-free data is a trap for the next
  // person who edits the file by hand.
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function main() {
  const count = Number(process.argv[2] ?? 10_000);
  const outPath = process.argv[3] ?? "employees.csv";
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Row count must be a positive integer, got: ${process.argv[2]}`);
  }

  const generated = generateEmployees(count);
  const lines = [HEADER.join(",")];

  for (const { employee, salaryRecords } of generated) {
    // The import format carries one salary per row (the hire record) -
    // raises are history, added afterwards through
    // POST /employees/:id/salary, never bulk-loaded.
    const hire = salaryRecords[0];
    if (!hire) throw new Error(`generated employee ${employee.employeeNumber} has no hire salary`);

    lines.push(
      [
        employee.employeeNumber,
        employee.firstName,
        employee.lastName,
        employee.email,
        employee.country,
        employee.department,
        employee.jobTitle,
        employee.level,
        employee.hireDate,
        hire.amount,
        hire.currency,
      ]
        .map(escapeCell)
        .join(","),
    );
  }

  const csv = lines.join("\n") + "\n";
  writeFileSync(outPath, csv, "utf8");
  console.log(`Wrote ${count.toLocaleString()} rows to ${outPath} (${(csv.length / 1024 / 1024).toFixed(2)} MB)`);
}

main();
