import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import { ApiError } from "@/lib/api";
import type {
  AiProposal,
  AnalyticsSummary,
  AuditLogResponse,
  EmployeeDetailResponse,
  EmployeeFilters,
  EmployeeListResponse,
  ImportResult,
  InvitationsResponse,
  EwaAccrual,
  EwaRequest,
  AttendanceResponse,
  TreasuryForecast,
  TlcCompareResponse,
  VestEvent,
  VestCalculatorResponse,
  LedgerEvent,
  MembersResponse,
  PayrollRun,
  PayrollRunLine,
  Organization,
  Role,
} from "@/lib/types";

// Every key leads with orgId. That isn't cosmetic: it's what stops a cached
// entry from the previous organization flashing on screen for a moment after
// switching orgs - the client-side mirror of the server's tenant isolation
// (design spec §8). Switching orgs needs no queryClient.clear(); the new keys
// simply miss.
export const keys = {
  organizations: ["organizations"] as const,
  employees: (orgId: string, filters: EmployeeFilters) => ["employees", orgId, filters] as const,
  employee: (orgId: string, id: string) => ["employee", orgId, id] as const,
  analytics: (orgId: string) => ["analytics-summary", orgId] as const,
  members: (orgId: string) => ["members", orgId] as const,
  invitations: (orgId: string) => ["invitations", orgId] as const,
  auditLog: (orgId: string, page: number) => ["audit-log", orgId, { page }] as const,
};

function errorMessage(err: unknown): string {
  // Surface the server's own zod-derived message, never a generic
  // "Something went wrong" (error-handling-logging.md rule 4).
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

function toQueryString(filters: EmployeeFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function useEmployees(filters: EmployeeFilters) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: keys.employees(activeOrgId ?? "", filters),
    queryFn: () =>
      api.request<EmployeeListResponse>(`/api/employees${toQueryString(filters)}`, { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

export function useEmployee(id: string | undefined) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: keys.employee(activeOrgId ?? "", id ?? ""),
    queryFn: () => api.request<EmployeeDetailResponse>(`/api/employees/${id}`, { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId && id),
  });
}

export interface Facets {
  departments: string[];
  countries: string[];
  levels: string[];
  currencies: string[];
}

export function useFacets() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["facets", activeOrgId ?? ""],
    queryFn: () => api.request<Facets>("/api/employees/facets", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
    staleTime: 60_000,
  });
}

// Payroll ledger is a scaffold surface, not wired into the salary domain's
// pagination/filter machinery yet - a flat list, same query-key discipline
// (org id leading) as everything else.
export function useLedgerEvents() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["ledger-events", activeOrgId ?? ""],
    queryFn: () => api.request<{ events: LedgerEvent[] }>("/api/ledger-events", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

export function useAiProposals() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["ai-proposals", activeOrgId ?? ""],
    queryFn: () => api.request<{ proposals: AiProposal[] }>("/api/ai-proposals", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

// --- Payroll runs ---

export function usePayrollRuns() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["payroll-runs", activeOrgId ?? ""],
    queryFn: () => api.request<{ runs: PayrollRun[] }>("/api/payroll-runs", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

export function usePayrollRun(runId: string | undefined) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["payroll-run", activeOrgId ?? "", runId ?? ""],
    queryFn: () =>
      api.request<{ run: PayrollRun; lines: PayrollRunLine[] }>(`/api/payroll-runs/${runId}`, {
        orgId: activeOrgId,
      }),
    enabled: Boolean(activeOrgId && runId),
    // While a run is mid-pipeline (just calculated, about to be reviewed and
    // posted) there is nothing else pushing updates - a light poll keeps a
    // second admin's screen in sync without needing websockets for this.
    refetchInterval: (query) => (query.state.data?.run.status === "draft" ? false : 4000),
  });
}

export function useCreatePayrollRun() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { periodStart: string; periodEnd: string; jurisdiction: string }, { orgId }) =>
      api.request<{ run: PayrollRun }>("/api/payroll-runs", { method: "POST", body, orgId }),
    {
      successMessage: () => "Payroll run created",
      invalidate: (orgId) => [["payroll-runs", orgId]],
    },
  );
}

export function useCalculatePayrollRun() {
  const { api } = useOrg();
  return useOrgMutation(
    (runId: string, { orgId }) =>
      api.request<{ run: PayrollRun; lineCount: number }>(`/api/payroll-runs/${runId}/calculate`, {
        method: "POST",
        orgId,
      }),
    {
      successMessage: (result) => `Calculated ${result.lineCount} line(s)`,
      invalidate: (orgId) => [["payroll-runs", orgId], ["payroll-run", orgId]],
    },
  );
}

export function usePostPayrollRun() {
  const { api } = useOrg();
  return useOrgMutation(
    (runId: string, { orgId }) =>
      api.request<{ run: PayrollRun; paychecksIssued: number }>(`/api/payroll-runs/${runId}/post`, {
        method: "POST",
        orgId,
      }),
    {
      successMessage: (result) => `Posted — ${result.paychecksIssued} paycheck(s) issued`,
      invalidate: (orgId) => [
        ["payroll-runs", orgId],
        ["payroll-run", orgId],
        ["ledger-events", orgId],
      ],
    },
  );
}

// --- AI pre-flight auditor + proposal review ---

export function useStartPreflightAudit() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { periodStart: string; periodEnd: string }, { orgId }) =>
      api.request<{ proposal: AiProposal; jobId: string }>("/api/payroll/preflight-audit", {
        method: "POST",
        body,
        orgId,
        // The backend's own model call alone has a 55s ceiling
        // (scaling-resilience.md rule 1), plus PII tokenization writes and
        // job bookkeeping around it - the client's blanket 70s default
        // (lib/api.ts) doesn't leave enough headroom for this one
        // genuinely slow route.
        signal: AbortSignal.timeout(120_000),
      }),
    {
      successMessage: () => "Pre-flight audit complete — see AI Proposals",
      invalidate: (orgId) => [["ai-proposals", orgId]],
    },
  );
}

// --- Legal-to-Code tax rule diff ---

export function useProposeTaxRuleDiff() {
  const { api } = useOrg();
  return useOrgMutation(
    (
      body: { jurisdiction: string; legalText?: string; proposedBrackets?: { upToAnnualMinor: number | null; rate: number }[] },
      { orgId },
    ) =>
      api.request<{ proposal: AiProposal; jobId: string }>("/api/tax-rules/propose-diff", {
        method: "POST",
        body,
        orgId,
        // Same rationale as the pre-flight auditor - the legalText path is a
        // real model call with the backend's own 55s ceiling.
        signal: AbortSignal.timeout(120_000),
      }),
    {
      successMessage: () => "Tax rule diff proposed — see AI Proposals",
      invalidate: (orgId) => [["ai-proposals", orgId]],
    },
  );
}

export function useReviewProposal() {
  const { api } = useOrg();
  return useOrgMutation(
    ({ proposalId, decision }: { proposalId: string; decision: "approved" | "rejected" }, { orgId }) =>
      api.request<{ proposal: AiProposal }>(`/api/ai-proposals/${proposalId}/review`, {
        method: "POST",
        body: { decision },
        orgId,
      }),
    {
      successMessage: (_result, args) => (args.decision === "approved" ? "Proposal approved" : "Proposal rejected"),
      invalidate: (orgId) => [["ai-proposals", orgId]],
    },
  );
}

// --- Earned Wage Access ---

export function useEwaRequests() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["ewa-requests", activeOrgId ?? ""],
    queryFn: () => api.request<{ requests: EwaRequest[] }>("/api/ewa/requests", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

export function useEwaAccrual(employeeId: string | null, periodStart: string, periodEnd: string) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["ewa-accrual", activeOrgId ?? "", employeeId ?? "", periodStart, periodEnd],
    queryFn: () =>
      api.request<EwaAccrual>(
        `/api/ewa/accrual/${employeeId}?periodStart=${periodStart}&periodEnd=${periodEnd}`,
        { orgId: activeOrgId },
      ),
    enabled: Boolean(activeOrgId && employeeId && periodStart && periodEnd),
  });
}

// --- Treasury forecast ---

export function useTreasuryForecast(startingCashBalanceMinor: number | null) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["treasury-forecast", activeOrgId ?? "", startingCashBalanceMinor ?? 0],
    queryFn: () =>
      api.request<TreasuryForecast>(
        `/api/treasury/forecast?startingCashBalanceMinor=${startingCashBalanceMinor}`,
        { orgId: activeOrgId },
      ),
    enabled: Boolean(activeOrgId && startingCashBalanceMinor !== null && !Number.isNaN(startingCashBalanceMinor)),
  });
}

// --- Global Total Landed Cost modeler ---

export function useTlcCompare(budgetUsdMinor: number | null) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["tlc-compare", activeOrgId ?? "", budgetUsdMinor ?? 0],
    queryFn: () =>
      api.request<TlcCompareResponse>(`/api/tlc/compare?budgetUsdMinor=${budgetUsdMinor}`, { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId && budgetUsdMinor !== null && !Number.isNaN(budgetUsdMinor)),
  });
}

// --- RSU / equity optimizer ---

export function useVestingSchedule() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { totalShares: number; vestingStartDate: string }, { orgId }) =>
      api.request<{ events: VestEvent[] }>("/api/rsu/vesting-schedule", { method: "POST", body, orgId }),
    {
      successMessage: (result) => `Schedule computed — ${result.events.length} vest event(s)`,
      invalidate: () => [],
    },
  );
}

export function useVestCalculator() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { sharesVesting: number; fmvPerShareMinor: number; jurisdiction: string }, { orgId }) =>
      api.request<VestCalculatorResponse>("/api/rsu/vest-calculator", { method: "POST", body, orgId }),
    {
      successMessage: () => "Vest tax and strategies computed",
      invalidate: () => [],
    },
  );
}

// --- HRIS attendance ---

export function useAttendance(employeeId: string | null, periodStart: string, periodEnd: string) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["attendance", activeOrgId ?? "", employeeId ?? "", periodStart, periodEnd],
    queryFn: () =>
      api.request<AttendanceResponse>(
        `/api/hris/attendance/${employeeId}?periodStart=${periodStart}&periodEnd=${periodEnd}`,
        { orgId: activeOrgId },
      ),
    enabled: Boolean(activeOrgId && employeeId && periodStart && periodEnd),
  });
}

export function useRequestEwaAdvance() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { employeeId: string; requestedMinor: number; periodStart: string; periodEnd: string }, { orgId }) =>
      api.request<{ request: EwaRequest }>("/api/ewa/requests", { method: "POST", body, orgId }),
    {
      successMessage: () => "Advance requested",
      invalidate: (orgId) => [["ewa-requests", orgId]],
    },
  );
}

export function useReviewEwaRequest() {
  const { api } = useOrg();
  return useOrgMutation(
    ({ requestId, decision }: { requestId: string; decision: "approved" | "rejected" }, { orgId }) =>
      api.request<{ request: EwaRequest }>(`/api/ewa/requests/${requestId}/review`, {
        method: "POST",
        body: { decision },
        orgId,
      }),
    {
      successMessage: (_result, args) => (args.decision === "approved" ? "Advance approved" : "Advance rejected"),
      invalidate: (orgId) => [
        ["ewa-requests", orgId],
        ["ledger-events", orgId],
      ],
    },
  );
}

export function useAnalytics() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: keys.analytics(activeOrgId ?? ""),
    queryFn: () => api.request<AnalyticsSummary>("/api/analytics/summary", { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId),
  });
}

export function useMembers() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: keys.members(activeOrgId ?? ""),
    queryFn: () =>
      api.request<MembersResponse>(`/api/organizations/${activeOrgId}/members?limit=100`, {
        orgId: activeOrgId,
      }),
    enabled: Boolean(activeOrgId),
  });
}

export function useInvitations() {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: keys.invitations(activeOrgId ?? ""),
    queryFn: () =>
      api.request<InvitationsResponse>(`/api/organizations/${activeOrgId}/invitations?limit=100`, {
        orgId: activeOrgId,
      }),
    enabled: Boolean(activeOrgId),
  });
}

export function useAuditLog(page: number) {
  const { api, activeOrgId } = useOrg();
  const limit = 25;
  return useQuery({
    queryKey: keys.auditLog(activeOrgId ?? "", page),
    queryFn: () =>
      api.request<AuditLogResponse>(`/api/audit-log?limit=${limit}&offset=${page * limit}`, {
        orgId: activeOrgId,
      }),
    enabled: Boolean(activeOrgId),
  });
}

// --- Mutations ---
// Plain invalidate-on-success, never optimistic updates: for compensation
// data a wrong optimistic flash that then reverts is worse than a brief
// loading state (design spec §8, a deliberate call).

function useOrgMutation<TArgs, TResult>(
  fn: (args: TArgs, ctx: { orgId: string }) => Promise<TResult>,
  opts: { successMessage: (result: TResult, args: TArgs) => string; invalidate: (orgId: string) => unknown[][] },
) {
  const { activeOrgId } = useOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs) => {
      if (!activeOrgId) throw new Error("No active organization");
      return fn(args, { orgId: activeOrgId });
    },
    onSuccess: (result, args) => {
      toast.success(opts.successMessage(result, args));
      if (activeOrgId) {
        for (const key of opts.invalidate(activeOrgId)) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function useCreateEmployee() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: unknown, { orgId }) =>
      api.request<{ employee: { id: string } }>("/api/employees", { method: "POST", body, orgId }),
    {
      successMessage: () => "Employee created",
      invalidate: (orgId) => [["employees", orgId], ["analytics-summary", orgId], ["audit-log", orgId]],
    },
  );
}

export function useUpdateEmployee(id: string) {
  const { api } = useOrg();
  return useOrgMutation(
    (body: unknown, { orgId }) =>
      api.request<{ employee: unknown }>(`/api/employees/${id}`, { method: "PUT", body, orgId }),
    {
      successMessage: () => "Employee updated",
      invalidate: (orgId) => [
        ["employees", orgId],
        ["employee", orgId, id],
        ["analytics-summary", orgId],
        ["audit-log", orgId],
      ],
    },
  );
}

export function useTerminateEmployee() {
  const { api } = useOrg();
  return useOrgMutation(
    (id: string, { orgId }) => api.request<{ ok: true }>(`/api/employees/${id}`, { method: "DELETE", orgId }),
    {
      // Distinct wording from an edit, so a soft-delete never reads like a
      // routine update (design spec §8).
      successMessage: () => "Employee terminated",
      invalidate: (orgId) => [["employees", orgId], ["analytics-summary", orgId], ["audit-log", orgId]],
    },
  );
}

export function useAddSalaryRecord(employeeId: string) {
  const { api } = useOrg();
  return useOrgMutation(
    (body: unknown, { orgId }) =>
      api.request<{ salaryRecord: unknown }>(`/api/employees/${employeeId}/salary`, {
        method: "POST",
        body,
        orgId,
      }),
    {
      successMessage: () => "Salary record added",
      invalidate: (orgId) => [
        ["employee", orgId, employeeId],
        ["employees", orgId],
        ["analytics-summary", orgId],
        ["audit-log", orgId],
      ],
    },
  );
}

export function useImportCsv() {
  const { api } = useOrg();
  return useOrgMutation(
    (csv: string, { orgId }) =>
      api.request<ImportResult>("/api/employees/import", {
        method: "POST",
        rawBody: { body: csv, contentType: "text/csv" },
        orgId,
      }),
    {
      successMessage: (result) =>
        `Import complete — ${result.created} created, ${result.updated} updated` +
        (result.failed.length > 0 ? `, ${result.failed.length} failed` : ""),
      invalidate: (orgId) => [["employees", orgId], ["analytics-summary", orgId], ["audit-log", orgId]],
    },
  );
}

export function useInviteMember() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { email: string; role: Role }, { orgId }) =>
      api.request<{ acceptUrl: string }>(`/api/organizations/${orgId}/invitations`, {
        method: "POST",
        body,
        orgId,
      }),
    {
      successMessage: () => "Invitation sent",
      invalidate: (orgId) => [["invitations", orgId]],
    },
  );
}

export function useRevokeInvitation() {
  const { api } = useOrg();
  return useOrgMutation(
    (invitationId: string, { orgId }) =>
      api.request<{ ok: true }>(`/api/organizations/${orgId}/invitations/${invitationId}`, {
        method: "DELETE",
        orgId,
      }),
    {
      successMessage: () => "Invitation revoked",
      invalidate: (orgId) => [["invitations", orgId]],
    },
  );
}

export function useChangeMemberRole() {
  const { api } = useOrg();
  return useOrgMutation(
    ({ membershipId, role }: { membershipId: string; role: Role }, { orgId }) =>
      api.request<{ ok: true }>(`/api/organizations/${orgId}/members/${membershipId}`, {
        method: "PATCH",
        body: { role },
        orgId,
      }),
    {
      successMessage: () => "Role changed",
      invalidate: (orgId) => [["members", orgId]],
    },
  );
}

export function useRemoveMember() {
  const { api } = useOrg();
  return useOrgMutation(
    (membershipId: string, { orgId }) =>
      api.request<{ ok: true }>(`/api/organizations/${orgId}/members/${membershipId}`, {
        method: "DELETE",
        orgId,
      }),
    {
      successMessage: () => "Member removed",
      invalidate: (orgId) => [["members", orgId]],
    },
  );
}

export interface JobRow {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobLogRow {
  id: string;
  level: string;
  message: string;
  createdAt: string;
}

export function useJob(jobId: string | null) {
  const { api, activeOrgId } = useOrg();
  return useQuery({
    queryKey: ["job", activeOrgId ?? "", jobId ?? ""],
    queryFn: () => api.request<{ job: JobRow; logs: JobLogRow[] }>(`/api/jobs/${jobId}`, { orgId: activeOrgId }),
    enabled: Boolean(activeOrgId && jobId),
    // While a job is running the row is the only progress signal there is.
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

export function useStartBulkDelete() {
  const { api } = useOrg();
  return useOrgMutation(
    (body: { employeeIds?: string[]; country?: string; department?: string }, { orgId }) =>
      api.request<{ job: JobRow }>("/api/employees/bulk-delete", { method: "POST", body, orgId }),
    {
      successMessage: (result) => `Queued termination of ${result.job.total} employees`,
      invalidate: (orgId) => [["jobs", orgId]],
    },
  );
}

export function useAdvanceJob() {
  const { api, activeOrgId } = useOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api.request<{ done: boolean; job: JobRow }>(`/api/jobs/${jobId}/advance`, {
        method: "POST",
        orgId: activeOrgId,
      }),
    onSuccess: (result) => {
      if (result.done && activeOrgId) {
        void queryClient.invalidateQueries({ queryKey: ["employees", activeOrgId] });
        void queryClient.invalidateQueries({ queryKey: ["analytics-summary", activeOrgId] });
        void queryClient.invalidateQueries({ queryKey: ["audit-log", activeOrgId] });
      }
    },
    // Errors surface through the job row's own status, so no toast here -
    // one failing chunk should not spam a toast per poll.
    onError: () => {},
  });
}

export function useCancelJob() {
  const { api } = useOrg();
  return useOrgMutation(
    (jobId: string, { orgId }) =>
      api.request<{ ok: true }>(`/api/jobs/${jobId}/cancel`, { method: "POST", orgId }),
    {
      successMessage: () => "Job cancelled",
      invalidate: (orgId) => [["job", orgId], ["jobs", orgId], ["employees", orgId]],
    },
  );
}

export function useCreateOrganization() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) =>
      api.request<{ organization: Organization }>("/api/organizations", { method: "POST", body }),
    onSuccess: () => {
      toast.success("Organization created");
      void queryClient.invalidateQueries({ queryKey: keys.organizations });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function useAcceptInvitation() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.request<{ organizationId: string; role: Role }>(`/api/invitations/${token}/accept`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Invitation accepted");
      void queryClient.invalidateQueries({ queryKey: keys.organizations });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}
