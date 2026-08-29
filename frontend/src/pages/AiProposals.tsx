import * as React from "react";
import { Scale, Sparkles } from "lucide-react";
import {
  useAiProposals,
  useProposeTaxRuleDiff,
  useReviewProposal,
  useStartPreflightAudit,
} from "@/hooks/queries";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { useOrg } from "@/lib/org-context";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
import type { AiProposal, TaxRuleDiffDetail } from "@/lib/types";

function statusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "approved") return "default";
  if (status === "rejected") return "destructive";
  return "secondary"; // pending
}

interface AnomalyFlag {
  employeeToken: string;
  reason: string;
  severity: "low" | "medium" | "high";
}

function severityVariant(sev: string): "outline" | "secondary" | "destructive" {
  if (sev === "high") return "destructive";
  if (sev === "medium") return "secondary";
  return "outline";
}

function renderTaxDiff(diff: TaxRuleDiffDetail) {
  if (diff.error) {
    return <p className="text-sm text-destructive">Model call failed: {diff.error}</p>;
  }
  if (diff.unparsed) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          The model&apos;s response didn&apos;t match the expected bracket schema — held unparsed rather than
          diffed.
        </p>
        <pre className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 text-xs">{diff.unparsed}</pre>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Annual salary</TableHead>
              <TableHead className="text-right">Current tax</TableHead>
              <TableHead className="text-right">Proposed tax</TableHead>
              <TableHead className="text-right">Delta</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.scenarios.map((s, i) => (
              <TableRow key={i}>
                <TableCell className="tabular-nums">{formatMoney(s.annualSalaryMinor / 100, "USD")}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(s.currentAnnualTaxMinor / 100, "USD")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(s.proposedAnnualTaxMinor / 100, "USD")}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums font-medium ${s.deltaMinor > 0 ? "text-destructive" : s.deltaMinor < 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}
                >
                  {s.deltaMinor > 0 ? "+" : ""}
                  {formatMoney(s.deltaMinor / 100, "USD")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Scenarios use fixed representative salaries, not real employee data — this diff never touches what a
        real payroll run computes; applying a new bracket table is a deliberately separate, unbuilt step.
      </p>
    </div>
  );
}

function renderDiff(proposal: AiProposal) {
  const diff = proposal.diff as
    | ({ flags?: AnomalyFlag[]; error?: string; unparsed?: string } & Partial<TaxRuleDiffDetail>)
    | null;
  if (!diff) return <p className="text-sm text-muted-foreground">No detail recorded.</p>;

  if (proposal.proposalType === "tax_diff") return renderTaxDiff(diff as TaxRuleDiffDetail);

  if (diff.error) {
    return <p className="text-sm text-destructive">Model call failed: {diff.error}</p>;
  }
  if (diff.unparsed) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          The model&apos;s response didn&apos;t match the expected schema — held unparsed rather than applied.
        </p>
        <pre className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 text-xs">{diff.unparsed}</pre>
      </div>
    );
  }
  if (diff.flags && diff.flags.length === 0) {
    return <p className="text-sm text-muted-foreground">No anomalies flagged for this period.</p>;
  }
  if (diff.flags) {
    return (
      <ul className="space-y-1.5">
        {diff.flags.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Badge variant={severityVariant(f.severity)} className="mt-0.5 shrink-0">
              {f.severity}
            </Badge>
            <span>
              <span className="font-mono text-xs text-muted-foreground">{f.employeeToken.slice(0, 8)}…</span>{" "}
              {f.reason}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return <pre className="text-xs">{JSON.stringify(diff, null, 2)}</pre>;
}

// The human-in-the-loop gate: nothing an AI proposes here ever touched
// payroll data on its own. Every row on this page is either pending review
// or a permanent record of who approved/rejected it and when (design
// spec's Rule #4 — deterministic subsystems, applied to the UI too: the
// model's output is shown, never auto-acted on).
export function AiProposalsPage() {
  const { isAdmin } = useOrg();
  const { data, isPending, isError, refetch } = useAiProposals();
  const review = useReviewProposal();
  const startAudit = useStartPreflightAudit();
  const proposeTaxDiff = useProposeTaxRuleDiff();
  const [auditOpen, setAuditOpen] = React.useState(false);
  const [taxDiffOpen, setTaxDiffOpen] = React.useState(false);
  const [periodStart, setPeriodStart] = React.useState("");
  const [periodEnd, setPeriodEnd] = React.useState("");
  const elapsed = useElapsedSeconds(startAudit.isPending);
  const taxDiffElapsed = useElapsedSeconds(proposeTaxDiff.isPending);

  const proposals = data?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === "pending");
  const reviewed = proposals.filter((p) => p.status !== "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI proposals"
        description="Every AI-generated suggestion, gated behind an explicit human decision before anything downstream changes."
        actions={
          isAdmin && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setTaxDiffOpen(true)}>
                <Scale />
                Propose tax rule diff
              </Button>
              <Button size="sm" onClick={() => setAuditOpen(true)}>
                <Sparkles />
                Run pre-flight audit
              </Button>
            </div>
          )
        }
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : proposals.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No proposals yet. A pre-flight audit is the first source — it flags salary anomalies for review,
            never changes anything on its own.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Pending review</h2>
              {pending.map((p) => (
                <Card key={p.id}>
                  <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        {p.proposalType.replace(/_/g, " ")}
                        <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                      </CardTitle>
                      <CardDescription>
                        {formatDate(p.createdAt)}
                        {p.modelUsed ? ` · ${p.modelUsed}` : ""}
                      </CardDescription>
                    </div>
                    {isAdmin && (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => review.mutate({ proposalId: p.id, decision: "rejected" })}
                          disabled={review.isPending}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => review.mutate({ proposalId: p.id, decision: "approved" })}
                          disabled={review.isPending}
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                  </CardHeader>
                  <CardContent>{renderDiff(p)}</CardContent>
                </Card>
              ))}
            </div>
          )}

          {reviewed.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Reviewed</h2>
              {reviewed.map((p) => (
                <Card key={p.id} className="opacity-80">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {p.proposalType.replace(/_/g, " ")}
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {p.reviewedBy && `Reviewed by ${p.reviewedBy}`}
                      {p.reviewedAt && ` · ${formatDate(p.reviewedAt)}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {renderDiff(p)}
                    {p.signOffHash && (
                      <p className="truncate font-mono text-xs text-muted-foreground" title={p.signOffHash}>
                        sign-off {p.signOffHash.slice(0, 16)}…
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run pre-flight audit</DialogTitle>
            <DialogDescription>
              Employee PII is tokenized before anything is sent to the model — it never sees a real name,
              email, or SSN. The model only flags rows for review; it never changes pay.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await startAudit.mutateAsync({ periodStart, periodEnd });
              setAuditOpen(false);
              setPeriodStart("");
              setPeriodEnd("");
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="auditStart">Period start</Label>
                <Input
                  id="auditStart"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auditEnd">Period end</Label>
                <Input
                  id="auditEnd"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  required
                />
              </div>
            </div>
            {startAudit.isPending && (
              <div className="space-y-1.5 rounded-md border p-3">
                <div className="flex items-center justify-between text-sm">
                  <span>Calling the model…</span>
                  <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[import-sweep_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  This is one API call, billed once (per-token, not free) regardless of how long it takes.
                  The model itself has a hard 55s server-side cutoff — closing this dialog does not cancel
                  it or send a second request either way.
                </p>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAuditOpen(false)}>
                {startAudit.isPending ? "Run in background" : "Cancel"}
              </Button>
              <Button type="submit" disabled={startAudit.isPending}>
                {startAudit.isPending ? `Running… ${elapsed}s` : "Run audit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ProposeTaxDiffDialog
        open={taxDiffOpen}
        onOpenChange={setTaxDiffOpen}
        proposeTaxDiff={proposeTaxDiff}
        elapsed={taxDiffElapsed}
      />
    </div>
  );
}

type ProposeTaxDiffMutation = ReturnType<typeof useProposeTaxRuleDiff>;

// Legal-to-Code Compliance Diff Engine's entry point: either paste the
// legal text and let the model extract a bracket table (validated
// server-side before it can influence anything), or skip the model
// entirely and enter the exact brackets directly - same "AI proposes,
// deterministic math verifies, human approves" shape as the pre-flight
// auditor, just for tax rules instead of payroll anomalies.
function ProposeTaxDiffDialog({
  open,
  onOpenChange,
  proposeTaxDiff,
  elapsed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposeTaxDiff: ProposeTaxDiffMutation;
  elapsed: number;
}) {
  const [jurisdiction, setJurisdiction] = React.useState("US-CA");
  const [mode, setMode] = React.useState<"legalText" | "brackets">("legalText");
  const [legalText, setLegalText] = React.useState("");
  const [bracketsJson, setBracketsJson] = React.useState(
    '[\n  { "upToAnnualMinor": 1000000, "rate": 0.1 },\n  { "upToAnnualMinor": null, "rate": 0.2 }\n]',
  );
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  function reset() {
    setLegalText("");
    setJsonError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Propose a tax rule diff</DialogTitle>
          <DialogDescription>
            Runs the proposed brackets against fixed representative salaries and compares to the live
            brackets — pure math, never the model. Nothing here changes what a real payroll run computes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setJsonError(null);
            if (mode === "legalText") {
              await proposeTaxDiff.mutateAsync({ jurisdiction, legalText });
            } else {
              let parsed: unknown;
              try {
                parsed = JSON.parse(bracketsJson);
              } catch {
                setJsonError("Not valid JSON.");
                return;
              }
              await proposeTaxDiff.mutateAsync({
                jurisdiction,
                proposedBrackets: parsed as { upToAnnualMinor: number | null; rate: number }[],
              });
            }
            onOpenChange(false);
            reset();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="taxDiffJurisdiction">Jurisdiction</Label>
            <NativeSelect
              id="taxDiffJurisdiction"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            >
              <option value="US-CA">US-CA</option>
              <option value="IN">IN</option>
              <option value="UK">UK</option>
            </NativeSelect>
          </div>

          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode("legalText")}
              className={`rounded-md border px-2.5 py-1 ${mode === "legalText" ? "border-primary bg-primary/10" : "border-input"}`}
            >
              From legal text (AI)
            </button>
            <button
              type="button"
              onClick={() => setMode("brackets")}
              className={`rounded-md border px-2.5 py-1 ${mode === "brackets" ? "border-primary bg-primary/10" : "border-input"}`}
            >
              Direct brackets (no AI)
            </button>
          </div>

          {mode === "legalText" ? (
            <div className="space-y-1.5">
              <Label htmlFor="legalText">Legal / regulatory text</Label>
              <Textarea
                id="legalText"
                rows={5}
                placeholder="Paste the bracket-relevant portion of the new law or regulation…"
                value={legalText}
                onChange={(e) => setLegalText(e.target.value)}
                required
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="bracketsJson">Proposed brackets (JSON array, upToAnnualMinor: null for the top)</Label>
              <Textarea
                id="bracketsJson"
                rows={6}
                className="font-mono text-xs"
                value={bracketsJson}
                onChange={(e) => setBracketsJson(e.target.value)}
                required
              />
              {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            </div>
          )}

          {proposeTaxDiff.isPending && mode === "legalText" && (
            <div className="space-y-1.5 rounded-md border p-3">
              <div className="flex items-center justify-between text-sm">
                <span>Extracting brackets from the text…</span>
                <span className="tabular-nums text-muted-foreground">{elapsed}s</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-[import-sweep_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
              </div>
              <p className="text-xs text-muted-foreground">
                One billed API call, regardless of how long it takes — closing this dialog does not cancel
                it or send a second request either way.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {proposeTaxDiff.isPending ? "Run in background" : "Cancel"}
            </Button>
            <Button type="submit" disabled={proposeTaxDiff.isPending}>
              {proposeTaxDiff.isPending ? `Running… ${elapsed}s` : "Propose diff"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
