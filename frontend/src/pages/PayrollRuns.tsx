import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Calculator, Plus, Send } from "lucide-react";
import { useCalculatePayrollRun, useCreatePayrollRun, usePayrollRun, usePayrollRuns, usePostPayrollRun } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { NativeSelect } from "@/components/combo-field";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "posted") return "default";
  if (status === "calculated") return "secondary";
  if (status === "cancelled") return "destructive";
  return "outline"; // draft
}

export function PayrollRunsPage() {
  const { orgSlug, isAdmin } = useOrg();
  const { data, isPending, isError, refetch } = usePayrollRuns();
  const createRun = useCreatePayrollRun();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [periodStart, setPeriodStart] = React.useState("");
  const [periodEnd, setPeriodEnd] = React.useState("");
  const [jurisdiction, setJurisdiction] = React.useState("US-CA");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll runs"
        description="Deterministic gross-to-net. Draft → calculated → posted — posting is the one step that writes real ledger entries."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              New run
            </Button>
          )
        }
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : data.runs.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No payroll runs yet. {isAdmin && 'Start one with "New run".'}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Jurisdiction</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total net</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      to={`/${orgSlug}/payroll-runs/${run.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {run.periodStart} → {run.periodEnd}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{run.jurisdiction}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {run.status === "draft" ? "—" : formatMoney(run.totalNetMinor / 100, "USD")}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(run.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New payroll run</DialogTitle>
            <DialogDescription>
              Every active employee with a salary on record is included when you calculate this run.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await createRun.mutateAsync({ periodStart, periodEnd, jurisdiction });
              setCreateOpen(false);
              setPeriodStart("");
              setPeriodEnd("");
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="periodStart">Period start</Label>
                <Input
                  id="periodStart"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="periodEnd">Period end</Label>
                <Input
                  id="periodEnd"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jurisdiction">Jurisdiction</Label>
              <NativeSelect id="jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                <option value="US-CA">US-CA — US federal + California (illustrative)</option>
                <option value="IN">IN — India, New Tax Regime FY2024-25</option>
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                Every line in a run is computed under one jurisdiction. An employee whose country doesn&apos;t
                match will be flagged, not silently skipped.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createRun.isPending}>
                {createRun.isPending ? "Creating…" : "Create draft"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PayrollRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { orgSlug, isAdmin } = useOrg();
  const { data, isPending, isError, refetch } = usePayrollRun(runId);
  const calculate = useCalculatePayrollRun();
  const post = usePostPayrollRun();

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isPending) return <Skeleton className="h-64 w-full" />;

  const { run, lines } = data;
  const supportedLines = lines.filter((l) => l.supported === "true");
  const unsupportedLines = lines.filter((l) => l.supported === "false");

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link to={`/${orgSlug}/payroll-runs`}>
          <ArrowLeft />
          Back to payroll runs
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {run.periodStart} → {run.periodEnd}
          </h1>
          <p className="text-sm text-muted-foreground">Jurisdiction {run.jurisdiction}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          {isAdmin && run.status === "draft" && (
            <Button size="sm" onClick={() => calculate.mutate(run.id)} disabled={calculate.isPending}>
              <Calculator />
              {calculate.isPending ? "Calculating…" : "Calculate"}
            </Button>
          )}
          {isAdmin && run.status === "calculated" && (
            // Posting writes real ledger entries and cannot be undone by
            // re-posting - the one destructive-feeling action here gets the
            // confirm dialog every other irreversible action in this app
            // uses.
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm">
                  <Send />
                  Post
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Post this payroll run?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This writes {supportedLines.length} paycheck event(s) to the ledger — double-entry,
                    permanent. It cannot be re-posted or undone from here; a correction would be a separate
                    reversal event.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => post.mutate(run.id)}>Post</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {run.status !== "draft" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total gross</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">{formatMoney(run.totalGrossMinor / 100, "USD")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total net</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">{formatMoney(run.totalNetMinor / 100, "USD")}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {unsupportedLines.length > 0 && (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">{unsupportedLines.length} employee(s) could not be included</p>
            <p className="text-muted-foreground">No tax rule set exists for their jurisdiction in this run.</p>
          </CardContent>
        </Card>
      )}

      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not calculated yet{isAdmin ? " — click Calculate above." : "."}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-mono text-xs">{line.employeeId.slice(0, 8)}…</TableCell>
                  {line.supported === "true" ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney((line.grossMinor ?? 0) / 100, line.currency ?? "USD")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatMoney(((line.grossMinor ?? 0) - (line.netMinor ?? 0)) / 100, line.currency ?? "USD")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatMoney((line.netMinor ?? 0) / 100, line.currency ?? "USD")}
                      </TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={3} className="text-sm text-destructive">
                      Unsupported: {line.unsupportedReason}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
