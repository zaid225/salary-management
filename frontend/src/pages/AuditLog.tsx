import * as React from "react";
import { useAuditLog } from "@/hooks/queries";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

const PAGE_SIZE = 25;

export function AuditLogPage() {
  const [page, setPage] = React.useState(0);
  const { data, isPending, isError, refetch } = useAuditLog(page);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every employee and salary mutation, with who did it and when."
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Actor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 4 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data.entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(e.createdAt)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          e.action === "delete" ? "destructive" : e.action === "create" ? "default" : "secondary"
                        }
                      >
                        {e.action}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{e.entityType.replace("_", " ")}</span>
                      <p className="font-mono text-xs text-muted-foreground">{e.entityId.slice(0, 8)}…</p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.actorClerkUserId}</TableCell>
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
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.entries.length < PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
