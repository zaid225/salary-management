import * as React from "react";
import { Plus } from "lucide-react";
import {
  useAttendance,
  useEmployees,
  useEwaAccrual,
  useEwaRequests,
  useRequestEwaAdvance,
  useReviewEwaRequest,
} from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/combo-field";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

function statusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "approved") return "default";
  if (status === "rejected") return "destructive";
  return "secondary"; // pending
}

// No employee self-service login exists in this app, so every request here
// is an admin acting on an employee's behalf - same convention as every
// other mutation in the product (design spec §1's explicit scope note).
export function EwaPage() {
  const { isAdmin } = useOrg();
  const { data, isPending, isError, refetch } = useEwaRequests();
  const review = useReviewEwaRequest();
  const [requestOpen, setRequestOpen] = React.useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Earned wage access"
        description="Accrual uses real clock-in/out hours when an HRIS has synced attendance for the period; otherwise it falls back to calendar-day proration (days elapsed ÷ days in the period)."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setRequestOpen(true)}>
              <Plus />
              New request
            </Button>
          )
        }
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : data.requests.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No advance requests yet.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="text-right">Accrued at request</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.employeeId.slice(0, 8)}…</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.periodStart} → {r.periodEnd}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(r.requestedMinor / 100, r.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatMoney(r.accruedAtRequestMinor / 100, r.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      {r.status === "pending" && (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={review.isPending}
                            onClick={() => review.mutate({ requestId: r.id, decision: "rejected" })}
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            disabled={review.isPending}
                            onClick={() => review.mutate({ requestId: r.id, decision: "approved" })}
                          >
                            Approve
                          </Button>
                        </div>
                      )}
                      {r.status !== "pending" && (
                        <span className="text-xs text-muted-foreground">
                          {r.reviewedBy && `by ${r.reviewedBy}`}
                          {r.reviewedAt && ` · ${formatDate(r.reviewedAt)}`}
                        </span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <RequestDialog open={requestOpen} onOpenChange={setRequestOpen} />
    </div>
  );
}

function RequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: employeesData } = useEmployees({ limit: 200, offset: 0 });
  const [employeeId, setEmployeeId] = React.useState("");
  const [periodStart, setPeriodStart] = React.useState("");
  const [periodEnd, setPeriodEnd] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const requestAdvance = useRequestEwaAdvance();

  const accrual = useEwaAccrual(employeeId || null, periodStart, periodEnd);
  const attendance = useAttendance(
    accrual.data?.accrualSource === "hours" ? employeeId || null : null,
    periodStart,
    periodEnd,
  );

  function reset() {
    setEmployeeId("");
    setPeriodStart("");
    setPeriodEnd("");
    setAmount("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request an advance</DialogTitle>
          <DialogDescription>
            The maximum allowed is 50% of what&apos;s accrued so far in the declared period, minus anything
            already advanced against it — enforced by the server regardless of what&apos;s entered here.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const requestedMinor = Math.round(Number(amount) * 100);
            await requestAdvance.mutateAsync({ employeeId, requestedMinor, periodStart, periodEnd });
            onOpenChange(false);
            reset();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ewaEmployee">Employee</Label>
            <NativeSelect
              id="ewaEmployee"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              required
            >
              <option value="">Select an employee</option>
              {(employeesData?.employees ?? []).map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.firstName} {emp.lastName} ({emp.employeeNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ewaStart">Period start</Label>
              <Input
                id="ewaStart"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ewaEnd">Period end</Label>
              <Input
                id="ewaEnd"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                required
              />
            </div>
          </div>

          {accrual.data && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <div className="flex items-center justify-between">
                <p>
                  Accrued so far: <span className="font-medium">
                    {formatMoney(accrual.data.accruedGrossMinor / 100, accrual.data.currency ?? "USD")}
                  </span>
                </p>
                <Badge variant={accrual.data.accrualSource === "hours" ? "default" : "outline"}>
                  {accrual.data.accrualSource === "hours" ? "attendance-verified" : "calendar estimate"}
                </Badge>
              </div>
              <p className="text-muted-foreground">
                Up to{" "}
                <span className="font-medium text-foreground">
                  {formatMoney(accrual.data.maxAllowedMinor / 100, accrual.data.currency ?? "USD")}
                </span>{" "}
                available to request
              </p>
              {attendance.data && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {attendance.data.attendance.totalHours} hours across {attendance.data.attendance.shifts.length}{" "}
                  shift(s) on record for this period.
                  {attendance.data.attendance.unpaired.length > 0 &&
                    ` ${attendance.data.attendance.unpaired.length} punch(es) unpaired — missing a clock in/out.`}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ewaAmount">Amount</Label>
            <Input
              id="ewaAmount"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="500.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={requestAdvance.isPending}>
              {requestAdvance.isPending ? "Requesting…" : "Request advance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
