// Response shapes returned by the Worker. Kept here rather than inferred
// from the backend's Drizzle types so the frontend doesn't take a build
// dependency on the Worker's model layer - only on its HTTP contract.
// (The zod *input* schemas are genuinely shared, see @shared/* - design
// spec §6.)

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export type Role = "admin" | "viewer";

export interface OrganizationMembership {
  organization: Organization;
  role: Role;
}

export interface SalaryRecord {
  id: string;
  organizationId: string;
  employeeId: string;
  amount: string;
  currency: string;
  effectiveDate: string;
  reason: "hire" | "raise" | "adjustment" | "correction";
  createdBy: string;
  createdAt: string;
}

export interface Employee {
  id: string;
  organizationId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  department: string;
  jobTitle: string;
  level: string;
  employmentStatus: "active" | "terminated";
  hireDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeWithSalary extends Employee {
  currentSalary: SalaryRecord | null;
}

export interface EmployeeListResponse {
  employees: EmployeeWithSalary[];
  total: number;
  limit: number;
  offset: number;
}

export interface EmployeeDetailResponse {
  employee: Employee;
  salaryHistory: SalaryRecord[];
}

export interface Member {
  membership: {
    id: string;
    organizationId: string;
    clerkUserId: string;
    role: Role;
    status: "active" | "removed";
    createdAt: string;
  };
  user: {
    clerkUserId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface MembersResponse {
  members: Member[];
  limit: number;
  offset: number;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: Role;
  token: string;
  status: "pending" | "accepted" | "revoked";
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationsResponse {
  invitations: Invitation[];
  limit: number;
  offset: number;
}

export interface Breakdown {
  headcount: number;
  avgUsd: number;
}

export interface AnalyticsSummary {
  headcount: number;
  avgUsd: number;
  medianUsd: number;
  totalCostUsd: number;
  byCountry: (Breakdown & { country: string })[];
  byDepartment: (Breakdown & { department: string })[];
  byLevel: (Breakdown & { level: string })[];
  coverage: {
    withSalary: number;
    included: number;
    excluded: number;
    missingCurrencies: string[];
  };
}

export interface AuditEntry {
  id: string;
  organizationId: string;
  actorClerkUserId: string;
  action: "create" | "update" | "delete";
  entityType: "employee" | "salary_record";
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditLogResponse {
  entries: AuditEntry[];
  limit: number;
  offset: number;
}

export interface ImportResult {
  created: number;
  updated: number;
  failed: { row: number; error: string }[];
}

export interface EmployeeFilters {
  country?: string;
  department?: string;
  status?: "active" | "terminated";
  search?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

// --- Payroll/treasury scaffold ---

export interface LedgerEvent {
  id: string;
  organizationId: string;
  sequence: string; // bigserial arrives as a string over JSON
  eventType: string;
  entityType: string;
  entityId: string;
  amountMinor: number | null;
  currency: string | null;
  payload: unknown;
  reversesEventId: string | null;
  actorClerkUserId: string;
  createdAt: string;
}

export interface AiProposal {
  id: string;
  organizationId: string;
  proposalType: string;
  status: "pending" | "approved" | "rejected";
  jobId: string | null;
  diff: unknown;
  modelUsed: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  signOffHash: string | null;
  createdAt: string;
}

export interface PayrollRun {
  id: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  jurisdiction: string;
  status: "draft" | "calculated" | "posted" | "cancelled";
  totalGrossMinor: number;
  totalNetMinor: number;
  createdBy: string;
  createdAt: string;
  calculatedAt: string | null;
  postedAt: string | null;
}

export interface PayrollRunLine {
  id: string;
  payrollRunId: string;
  employeeId: string;
  jurisdiction: string;
  supported: "true" | "false";
  grossMinor: number | null;
  netMinor: number | null;
  currency: string | null;
  deductions: { type: string; amountMinor: number }[] | null;
  unsupportedReason: string | null;
}

export interface EwaRequest {
  id: string;
  organizationId: string;
  employeeId: string;
  requestedMinor: number;
  periodStart: string;
  periodEnd: string;
  accruedAtRequestMinor: number;
  maxAllowedAtRequestMinor: number;
  currency: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  ledgerEventId: string | null;
  createdAt: string;
}

export interface EwaAccrual {
  accruedGrossMinor: number;
  maxAllowedMinor: number;
  currency: string | null;
  // "hours" once real HRIS punches exist for the employee/period, otherwise
  // "calendar" (calendar-day proration) - see hono-worker/src/lib/hris.ts.
  accrualSource: "hours" | "calendar";
}

// --- HRIS attendance ---

export interface TimeEntry {
  id: string;
  organizationId: string;
  employeeId: string;
  type: "clock_in" | "clock_out";
  occurredAt: string;
  source: string;
  externalId: string;
  createdAt: string;
}

export interface Shift {
  clockIn: string;
  clockOut: string;
  hours: number;
}

// --- Legal-to-Code tax rule diff ---

export interface TaxBracketWire {
  upToAnnualMinor: number | null; // null = open-ended top bracket
  rate: number;
}

export interface TaxDiffScenario {
  annualSalaryMinor: number;
  currentAnnualTaxMinor: number;
  proposedAnnualTaxMinor: number;
  deltaMinor: number;
}

export interface TaxRuleDiffDetail {
  jurisdiction: string;
  currentBrackets?: TaxBracketWire[];
  proposedBrackets?: TaxBracketWire[];
  scenarios: TaxDiffScenario[];
  totalDeltaMinor?: number;
  error?: string | null;
  unparsed?: string | null;
}

export interface AttendanceResponse {
  entries: TimeEntry[];
  attendance: {
    shifts: Shift[];
    totalHours: number;
    unpaired: { type: "clock_in" | "clock_out"; occurredAt: string }[];
  };
}
