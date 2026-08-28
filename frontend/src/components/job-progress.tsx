import * as React from "react";
import { CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import { useAdvanceJob, useCancelJob, useJob } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const ACTIVE_JOB_KEY = "activeJobId";

export function rememberActiveJob(jobId: string): void {
  try {
    localStorage.setItem(ACTIVE_JOB_KEY, jobId);
  } catch {
    // Non-fatal: the panel just won't reappear automatically on reload.
  }
}

export function readActiveJob(): string | null {
  try {
    return localStorage.getItem(ACTIVE_JOB_KEY);
  } catch {
    return null;
  }
}

function forgetActiveJob(): void {
  try {
    localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Watches one job and, while it is unfinished, drives it forward a chunk at a
 * time.
 *
 * The job's progress lives in the database, not here, so closing the tab
 * pauses the work rather than losing it: coming back re-attaches to the same
 * job at the same point, and Resume picks it up. That is the difference
 * between "persisted" and "unattended" — see the note in the panel itself.
 */
export function JobProgress({ jobId, onDismiss }: { jobId: string; onDismiss: () => void }) {
  const { data } = useJob(jobId);
  const advance = useAdvanceJob();
  const cancel = useCancelJob();
  const [autoRun, setAutoRun] = React.useState(true);

  const job = data?.job;
  const isActive = job?.status === "queued" || job?.status === "running";

  // One chunk at a time, and only ever one in flight - the next call is
  // issued after the previous one lands, so a slow chunk cannot pile up.
  React.useEffect(() => {
    if (!job || !isActive || !autoRun || advance.isPending) return;
    let cancelled = false;
    void advance.mutateAsync(jobId).catch(() => {
      if (!cancelled) setAutoRun(false);
    });
    return () => {
      cancelled = true;
    };
  }, [job, isActive, autoRun, advance, jobId]);

  React.useEffect(() => {
    if (job && !isActive) forgetActiveJob();
  }, [job, isActive]);

  if (!job) return null;

  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {isActive ? (
              <Loader2 className="size-4 animate-spin" />
            ) : job.status === "succeeded" ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <XCircle className="size-4 text-destructive" />
            )}
            <span className="text-sm font-medium">Bulk termination</span>
            <Badge variant={job.status === "succeeded" ? "secondary" : isActive ? "default" : "outline"}>
              {job.status}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {isActive && !autoRun && (
              <Button size="sm" variant="outline" onClick={() => setAutoRun(true)}>
                <Play />
                Resume
              </Button>
            )}
            {isActive && (
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate(jobId)}>
                Cancel
              </Button>
            )}
            {!isActive && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  forgetActiveJob();
                  onDismiss();
                }}
              >
                Dismiss
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            {job.processed.toLocaleString()} of {job.total.toLocaleString()} ({pct}%)
          </p>
        </div>

        {isActive && (
          <p className="text-xs text-muted-foreground">
            Progress is saved on the server. You can close this tab — the work already done is kept, and
            reopening this page picks the job back up.
          </p>
        )}

        {data.logs.length > 0 && (
          <details className="min-w-0">
            <summary className="cursor-pointer text-xs font-medium">Log</summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {data.logs.map((l) => (
                <li key={l.id} className={l.level === "error" ? "text-destructive" : undefined}>
                  {l.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
