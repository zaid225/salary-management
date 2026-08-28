import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useEmployees, useStartBulkDelete } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { cn, formatMoney } from "@/lib/utils";
import type { EmployeeFilters } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";
import { CreateEmployeeDialog } from "@/components/create-employee-dialog";
import { ImportCsvDialog } from "@/components/import-csv-dialog";
import { JobProgress, rememberActiveJob, readActiveJob } from "@/components/job-progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PAGE_SIZES = [25, 50, 100, 200, 500, 1000];
// Below this a plain table is faster than virtualizing it.
const VIRTUALIZE_ABOVE = 100;
const DEFAULT_PAGE_SIZE = 25;

// Filter/sort/pagination state lives in the URL, not component state -
// shareable and bookmarkable, and it feeds the query key directly
// (design spec §8). The *server* does the filtering; this never fetches a
// full list and slices it client-side.
export function EmployeesPage() {
  const [params, setParams] = useSearchParams();
  const { isAdmin, api, activeOrgId, orgSlug } = useOrg();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [searchDraft, setSearchDraft] = React.useState(params.get("search") ?? "");
  const [exporting, setExporting] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  // "Select all N matching filters" vs. the checkboxes on this page - two
  // different targets, and the confirm dialog must say which one plainly.
  const [selectAllMatching, setSelectAllMatching] = React.useState(false);
  // A job started in a previous visit is picked back up here.
  const [jobId, setJobId] = React.useState<string | null>(() => readActiveJob());
  const startBulkDelete = useStartBulkDelete();

  const page = Number(params.get("page") ?? "0");
  const pageSize = (() => {
    const raw = Number(params.get("pageSize") ?? DEFAULT_PAGE_SIZE);
    return PAGE_SIZES.includes(raw) ? raw : DEFAULT_PAGE_SIZE;
  })();
  const filters: EmployeeFilters = {
    limit: pageSize,
    offset: page * pageSize,
    ...(params.get("search") ? { search: params.get("search")! } : {}),
    ...(params.get("country") ? { country: params.get("country")! } : {}),
    ...(params.get("department") ? { department: params.get("department")! } : {}),
    ...(params.get("status") ? { status: params.get("status") as "active" | "terminated" } : {}),
    ...(params.get("sort") ? { sort: params.get("sort")! } : {}),
    ...(params.get("order") ? { order: params.get("order")! } : {}),
  };

  const sort = params.get("sort") ?? "employeeNumber";
  const order = params.get("order") === "desc" ? "desc" : "asc";

  // Clicking the active column flips direction; a new column starts ascending.
  function toggleSort(column: string) {
    const next = new URLSearchParams(params);
    if (sort === column && order === "asc") next.set("order", "desc");
    else next.set("order", "asc");
    next.set("sort", column);
    next.delete("page");
    setParams(next, { replace: true });
  }

  function SortHeader({ column, label, align }: { column: string; label: string; align?: "right" }) {
    const active = sort === column;
    const Icon = !active ? ChevronsUpDown : order === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={align === "right" ? "text-right" : undefined}>
        <button
          type="button"
          onClick={() => toggleSort(column)}
          aria-label={`Sort by ${label}`}
          className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
        >
          {label}
          <Icon className="size-3" />
        </button>
      </TableHead>
    );
  }

  const { data, isPending, isError, refetch } = useEmployees(filters);
  const pageIds = React.useMemo(() => (data?.employees ?? []).map((e) => e.id), [data]);

  // Past a few hundred rows the browser spends longer laying out DOM than the
  // API spends fetching, so only the visible slice is mounted. Below that the
  // plain table is cheaper than the machinery, so it stays as it was.
  const rows = data?.employees ?? [];
  const virtualize = rows.length > VIRTUALIZE_ABOVE;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 57,
    overscan: 12,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualize && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualize && virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;
  const visibleRows = virtualize ? virtualItems.map((v) => rows[v.index]!) : rows;
  const bulkCount = selectAllMatching ? (data?.total ?? 0) : selected.size;

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change resets to the first page - otherwise a narrower
    // filter can land the user on an empty page 4.
    if (key !== "page") next.delete("page");
    setParams(next, { replace: true });
  }

  async function onExport() {
    // Exporting the current view when the current view is empty just hands
    // the user a header-only file and looks broken - say so instead.
    if (!data || data.employees.length === 0) {
      toast.info("Nothing to export — no employees match these filters.");
      return;
    }
    setExporting(true);
    try {
      await runExport();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function runExport() {
    const csv = await api.request<string>(
      `/api/employees/export?${new URLSearchParams(
        Object.entries(filters)
          .filter(([k, v]) => k !== "limit" && k !== "offset" && v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString()}`,
      { orgId: activeOrgId },
    );
    // The browser can't be handed a file by the API directly (it needs the
    // auth header), so the CSV comes back as text and is saved client-side.
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "employees-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        description="Filter, search and page through this organization's roster."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onExport()}
              disabled={exporting || isPending || !data || data.employees.length === 0}
            >
              <Download />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
            {isAdmin && bulkCount > 0 && (
              <Button variant="destructive" size="sm" onClick={() => setConfirmBulk(true)}>
                <Trash2 />
                Terminate {bulkCount.toLocaleString()}
              </Button>
            )}
            {isAdmin && (
              <>
                <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                  <Upload />
                  Import CSV
                </Button>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  Add employee
                </Button>
              </>
            )}
          </>
        }
      />

      {jobId && <JobProgress jobId={jobId} onDismiss={() => setJobId(null)} />}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParam("search", searchDraft.trim());
        }}
      >
        <Input
          placeholder="Search name or employee number"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          className="max-w-xs"
        />
        <Input
          placeholder="Country (e.g. US)"
          defaultValue={params.get("country") ?? ""}
          onBlur={(e) => setParam("country", e.target.value.trim().toUpperCase())}
          className="max-w-40"
        />
        <Input
          placeholder="Department"
          defaultValue={params.get("department") ?? ""}
          onBlur={(e) => setParam("department", e.target.value.trim())}
          className="max-w-48"
        />
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
        {[...params.keys()].some((k) => k !== "page") && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchDraft("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {isAdmin && data && pageIds.length > 0 && pageIds.every((id) => selected.has(id)) && data.total > pageIds.length && (
        <div className="flex items-center justify-between rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {selectAllMatching ? (
            <span>
              All <strong>{data.total.toLocaleString()}</strong> employees matching these filters are selected.
            </span>
          ) : (
            <span>{selected.size} selected on this page.</span>
          )}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              if (selectAllMatching) {
                setSelectAllMatching(false);
                setSelected(new Set());
              } else {
                setSelectAllMatching(true);
              }
            }}
          >
            {selectAllMatching ? "Clear selection" : `Select all ${data.total.toLocaleString()} matching filters`}
          </Button>
        </div>
      )}

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <div
          ref={scrollRef}
          className={cn("rounded-lg border", virtualize && "max-h-[70vh] overflow-y-auto")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                {isAdmin && (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      className="size-4 align-middle"
                      checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))}
                      onChange={(e) => {
                        setSelectAllMatching(false);
                        const next = new Set(selected);
                        if (e.target.checked) pageIds.forEach((id) => next.add(id));
                        else pageIds.forEach((id) => next.delete(id));
                        setSelected(next);
                      }}
                    />
                  </TableHead>
                )}
                <SortHeader column="lastName" label="Employee" />
                <SortHeader column="employeeNumber" label="Number" />
                <SortHeader column="department" label="Department" />
                <SortHeader column="level" label="Level" />
                <SortHeader column="country" label="Country" />
                <SortHeader column="currentSalary" label="Current salary" align="right" />
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                // Skeleton rows, not a spinner - better perceived
                // performance for a table the user is about to scan.
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: isAdmin ? 8 : 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data.employees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 8 : 7} className="py-10 text-center text-sm text-muted-foreground">
                    No employees match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {paddingTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={isAdmin ? 8 : 7} style={{ height: paddingTop }} />
                    </tr>
                  )}
                  {visibleRows.map((e) => (
                  <TableRow key={e.id}>
                    {isAdmin && (
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${e.firstName} ${e.lastName}`}
                          className="size-4 align-middle"
                          checked={selected.has(e.id)}
                          onChange={(ev) => {
                            setSelectAllMatching(false);
                            const next = new Set(selected);
                            if (ev.target.checked) next.add(e.id);
                            else next.delete(e.id);
                            setSelected(next);
                          }}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <Link to={`/${orgSlug}/employees/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                        {e.firstName} {e.lastName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{e.email}</p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.employeeNumber}</TableCell>
                    <TableCell>{e.department}</TableCell>
                    <TableCell>{e.level}</TableCell>
                    <TableCell>{e.country}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.currentSalary
                        ? formatMoney(e.currentSalary.amount, e.currentSalary.currency)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.employmentStatus === "active" ? "secondary" : "outline"}>
                        {e.employmentStatus}
                      </Badge>
                    </TableCell>
                  </TableRow>
                  ))}
                  {paddingBottom > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={isAdmin ? 8 : 7} style={{ height: paddingBottom }} />
                    </tr>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Rows per page</span>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            value={pageSize}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set("pageSize", e.target.value);
              // Row 300 of the old page size is not row 300 of the new one.
              next.delete("page");
              setParams(next, { replace: true });
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>· Page {page + 1}</span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setParam("page", String(page - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.employees.length < pageSize}
            onClick={() => setParam("page", String(page + 1))}
          >
            Next
          </Button>
        </div>
      </div>

      <AlertDialog
        open={confirmBulk}
        onOpenChange={(o) => {
          setConfirmBulk(o);
          if (!o) setConfirmText("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Terminate {bulkCount.toLocaleString()} {bulkCount === 1 ? "employee" : "employees"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will be marked terminated and leave the active roster. Salary history and the audit trail
              are kept — this is not a hard delete. The work runs as a background job you can watch, leave,
              and come back to.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {selectAllMatching && (
            <div className="space-y-2 rounded-md border border-destructive/40 p-3">
              <p className="text-sm font-medium text-destructive">
                This applies to every employee matching the current filters, not just this page.
              </p>
              {/* Typing the word is the point: a bulk action this wide should
                  not be one mis-aimed click away. */}
              <label className="block text-xs text-muted-foreground" htmlFor="confirm-bulk">
                Type <span className="font-mono font-semibold text-foreground">TERMINATE</span> to confirm
              </label>
              <Input
                id="confirm-bulk"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="TERMINATE"
                autoComplete="off"
              />
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={selectAllMatching && confirmText !== "TERMINATE"}
              onClick={async () => {
                // Select-all sends the filters, not ids: the set is defined by
                // the query, so the job stays correct for rows the client
                // never had on screen.
                const payload = selectAllMatching
                  ? {
                      ...(filters.country ? { country: filters.country } : {}),
                      ...(filters.department ? { department: filters.department } : {}),
                    }
                  : { employeeIds: [...selected] };
                const result = await startBulkDelete.mutateAsync(payload);
                rememberActiveJob(result.job.id);
                setJobId(result.job.id);
                setSelected(new Set());
                setSelectAllMatching(false);
                setConfirmText("");
              }}
            >
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
