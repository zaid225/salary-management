import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { useEmployees } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { formatMoney } from "@/lib/utils";
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

const PAGE_SIZE = 25;

// Filter/sort/pagination state lives in the URL, not component state -
// shareable and bookmarkable, and it feeds the query key directly
// (design spec §8). The *server* does the filtering; this never fetches a
// full list and slices it client-side.
export function EmployeesPage() {
  const [params, setParams] = useSearchParams();
  const { isAdmin, api, activeOrgId } = useOrg();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [searchDraft, setSearchDraft] = React.useState(params.get("search") ?? "");
  const [exporting, setExporting] = React.useState(false);

  const page = Number(params.get("page") ?? "0");
  const filters: EmployeeFilters = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(params.get("search") ? { search: params.get("search")! } : {}),
    ...(params.get("country") ? { country: params.get("country")! } : {}),
    ...(params.get("department") ? { department: params.get("department")! } : {}),
    ...(params.get("status") ? { status: params.get("status") as "active" | "terminated" } : {}),
  };

  const { data, isPending, isError, refetch } = useEmployees(filters);

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

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Country</TableHead>
                <TableHead className="text-right">Current salary</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                // Skeleton rows, not a spinner - better perceived
                // performance for a table the user is about to scan.
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data.employees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No employees match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                data.employees.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link to={`/employees/${e.id}`} className="font-medium underline-offset-4 hover:underline">
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
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Page {page + 1}</p>
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
            disabled={!data || data.employees.length < PAGE_SIZE}
            onClick={() => setParam("page", String(page + 1))}
          >
            Next
          </Button>
        </div>
      </div>

      <CreateEmployeeDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
