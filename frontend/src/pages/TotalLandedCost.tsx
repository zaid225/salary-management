import * as React from "react";
import { Globe2 } from "lucide-react";
import { useTlcCompare } from "@/hooks/queries";
import { formatMoney } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

function contributionLabel(type: string): string {
  return type.replace(/_/g, " ");
}

// Deterministic, zero AI (Rule #1) - shows what one USD hiring budget
// actually costs to land in each supported jurisdiction, once employer-side
// statutory contributions (not deducted from the employee, paid on top by
// the employer) are added and converted back to USD for comparison.
export function TotalLandedCostPage() {
  const [budgetInput, setBudgetInput] = React.useState("100000");
  const budgetUsdMinor = budgetInput === "" ? null : Math.round(Number(budgetInput) * 100);
  const { data, isPending, isError, refetch } = useTlcCompare(budgetUsdMinor);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Global total landed cost"
        description="One hiring budget, compared across jurisdictions once employer-side statutory contributions are added — pure math, no AI."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Hiring budget</CardTitle>
          <CardDescription>What you'd pay this role in gross salary, in USD.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="tlcBudget">Budget (USD/year)</Label>
            <Input
              id="tlcBudget"
              type="number"
              step="1000"
              min="0"
              placeholder="100000"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {budgetUsdMinor === null ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Enter a budget above to compare jurisdictions.
          </CardContent>
        </Card>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {data.results.map((r) => (
            <Card key={r.jurisdiction}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Globe2 className="size-4 text-muted-foreground" />
                  {r.jurisdiction}
                </CardTitle>
                <CardDescription>{r.currency}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {r.missingFxRate ? (
                  <p className="text-sm text-muted-foreground">
                    No FX rate on file for {r.currency} — excluded from the comparison.
                  </p>
                ) : r.error ? (
                  <p className="text-sm text-destructive">{r.error}</p>
                ) : (
                  <>
                    <div>
                      <p className="text-2xl font-semibold tracking-tight">
                        {formatMoney((r.totalLandedCostUsdMinor ?? 0) / 100, "USD")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        true cost, vs {formatMoney(data.budgetUsdMinor / 100, "USD")} gross budget
                      </p>
                    </div>
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Employer contribution</TableHead>
                            <TableHead className="text-right">{r.currency}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(r.employerContributions ?? []).map((c) => (
                            <TableRow key={c.type}>
                              <TableCell className="capitalize">{contributionLabel(c.type)}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatMoney(c.amountMinor / 100, r.currency)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Local total: {formatMoney((r.totalLandedCostLocalMinor ?? 0) / 100, r.currency)}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
