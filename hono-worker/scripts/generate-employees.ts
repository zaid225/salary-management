// Deterministic (seeded RNG, not Math.random()) so re-running the seed
// script produces the same dataset - design spec §9.
const COUNTRIES: { code: string; currency: string; baseSalary: number }[] = [
  { code: "US", currency: "USD", baseSalary: 95000 },
  { code: "GB", currency: "GBP", baseSalary: 65000 },
  { code: "DE", currency: "EUR", baseSalary: 60000 },
  { code: "IN", currency: "INR", baseSalary: 1800000 },
  { code: "CA", currency: "CAD", baseSalary: 85000 },
  { code: "AU", currency: "AUD", baseSalary: 90000 },
  { code: "FR", currency: "EUR", baseSalary: 55000 },
  { code: "SG", currency: "SGD", baseSalary: 80000 },
];
const DEPARTMENTS = [
  "Engineering",
  "Sales",
  "Product",
  "Marketing",
  "Finance",
  "People",
  "Operations",
  "Support",
];
const LEVELS = ["L1", "L2", "L3", "L4", "L5", "M1", "M2"];
const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Sam", "Jamie", "Avery", "Quinn"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Lee", "Patel"];

// Mulberry32 - tiny, fast, deterministic PRNG (no external dependency).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() called on empty array");
  return item;
}

export interface GeneratedEmployee {
  employee: {
    employeeNumber: string;
    firstName: string;
    lastName: string;
    email: string;
    country: string;
    department: string;
    jobTitle: string;
    level: string;
    hireDate: string;
  };
  salaryRecords: { amount: string; currency: string; effectiveDate: string; reason: "hire" | "raise" }[];
}

export function generateEmployees(count: number, seed = 42): GeneratedEmployee[] {
  const rng = mulberry32(seed);
  const out: GeneratedEmployee[] = [];

  for (let i = 0; i < count; i++) {
    const country = pick(rng, COUNTRIES);
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const department = pick(rng, DEPARTMENTS);
    const level = pick(rng, LEVELS);
    const employeeNumber = `EMP-${String(i + 1).padStart(6, "0")}`;
    const hireYear = 2018 + Math.floor(rng() * 7);
    const hireDate = `${hireYear}-${String(1 + Math.floor(rng() * 12)).padStart(2, "0")}-${String(
      1 + Math.floor(rng() * 28),
    ).padStart(2, "0")}`;

    const salaryVariance = 0.7 + rng() * 0.8; // 0.7x-1.5x of country base
    const hireAmount = Math.round(country.baseSalary * salaryVariance);

    const records: GeneratedEmployee["salaryRecords"] = [
      { amount: hireAmount.toFixed(2), currency: country.currency, effectiveDate: hireDate, reason: "hire" },
    ];

    const raiseCount = Math.floor(rng() * 3); // 0-2 raises
    let currentAmount = hireAmount;
    for (let r = 0; r < raiseCount; r++) {
      currentAmount = Math.round(currentAmount * (1.03 + rng() * 0.12));
      const raiseYear = hireYear + r + 1;
      records.push({
        amount: currentAmount.toFixed(2),
        currency: country.currency,
        effectiveDate: `${raiseYear}-${String(1 + Math.floor(rng() * 12)).padStart(2, "0")}-01`,
        reason: "raise",
      });
    }

    out.push({
      employee: {
        employeeNumber,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
        country: country.code,
        department,
        jobTitle: `${department} ${level}`,
        level,
        hireDate,
      },
      salaryRecords: records,
    });
  }

  return out;
}
