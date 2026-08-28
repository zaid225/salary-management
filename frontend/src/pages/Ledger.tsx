import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLedgerEvents } from "@/hooks/queries";
import { formatDate, formatMoney } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

// Same threshold and virtualizer setup as Employees.tsx - past a few hundred
// rows a plain table costs more in layout than the machinery saves fetching.
const VIRTUALIZE_ABOVE = 100;

// Read-only, on purpose: the ledger is append-only (design constraint #2 —
// nothing here is an editable cell). A "reverse this event" action would
// open the same AlertDialog-confirm pattern used for terminate-employee and
// POST a new reversal event, never PATCH this row - not wired in this
// scaffold pass.
export function LedgerPage() {
  const { data, isPending, isError, refetch } = useLedgerEvents();
  const rows = data?.events ?? [];
  const virtualize = rows.length > VIRTUALIZE_ABOVE;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    overscan: 12,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualize && virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualize && virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;
  const visibleRows = virtualize ? virtualItems.map((v) => rows[v.index]!) : rows;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledger"
        description="Every event, append-only. Corrections are new reversal events, never an edit."
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <div
          ref={scrollRef}
          className={virtualize ? "max-h-[70vh] overflow-y-auto rounded-lg border" : "rounded-lg border"}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Seq</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No ledger events yet.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {paddingTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={6} style={{ height: paddingTop }} />
                    </tr>
                  )}
                  {visibleRows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{e.sequence}</TableCell>
                      <TableCell>
                        <Badge variant={e.eventType === "reversal" ? "destructive" : "outline"}>
                          {e.eventType.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.entityType} <span className="font-mono">{e.entityId.slice(0, 8)}…</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {e.amountMinor !== null && e.currency
                          ? formatMoney(e.amountMinor / 100, e.currency)
                          : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.actorClerkUserId}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {paddingBottom > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={6} style={{ height: paddingBottom }} />
                    </tr>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
