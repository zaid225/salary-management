import * as React from "react";
import { Calculator, LineChart } from "lucide-react";
import { useVestCalculator, useVestingSchedule } from "@/hooks/queries";
import { formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";

const STRATEGY_LABEL: Record<string, string> = {
  sell_to_cover: "Sell-to-cover",
  same_day_sale: "Same-day sale",
  hold_pay_cash: "Hold, pay cash",
};

// Deterministic RSU vesting schedule + vest-time tax withholding + strategy
// comparison - zero AI (Rule #1). Stateless: no grant is stored, this is a
// what-if calculator (see rsu-optimizer.ts's scope note).
export function RsuOptimizerPage() {
  const [totalShares, setTotalShares] = React.useState("4800");
  const [vestingStartDate, setVestingStartDate] = React.useState("");
  const schedule = useVestingSchedule();

  const [sharesVesting, setSharesVesting] = React.useState("1000");
  const [fmvPerShare, setFmvPerShare] = React.useState("50.00");
  const calculator = useVestCalculator();

  return (
    <div className="space-y-6">
      <PageHeader
        title="RSU & equity optimizer"
        description="Deterministic vesting schedule and vest-tax strategy comparison — every number computed exactly, no AI recommendation involved."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <LineChart className="size-4" />
              Vesting schedule
            </CardTitle>
            <CardDescription>Standard 4-year, 1-year-cliff schedule: 25% at 12 months, then equal monthly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="grid grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                schedule.mutate({ totalShares: Number(totalShares), vestingStartDate });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="totalShares">Total shares</Label>
                <Input
                  id="totalShares"
                  type="number"
                  min="1"
                  step="1"
                  value={totalShares}
                  onChange={(e) => setTotalShares(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vestingStartDate">Vesting start date</Label>
                <Input
                  id="vestingStartDate"
                  type="date"
                  value={vestingStartDate}
                  onChange={(e) => setVestingStartDate(e.target.value)}
                  required
                />
              </div>
              <div className="col-span-2">
                <Button type="submit" size="sm" disabled={schedule.isPending}>
                  {schedule.isPending ? "Computing…" : "Compute schedule"}
                </Button>
              </div>
            </form>

            {schedule.data && (
              <div className="max-h-72 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>Vest date</TableHead>
                      <TableHead className="text-right">Shares</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schedule.data.events.map((ev) => (
                      <TableRow key={ev.monthIndex}>
                        <TableCell className="tabular-nums">{ev.monthIndex}</TableCell>
                        <TableCell>{formatDate(ev.vestDate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{ev.shares.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Calculator className="size-4" />
              Vest tax &amp; strategies
            </CardTitle>
            <CardDescription>What one vest event costs in tax, and three ways to cover it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="grid grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                calculator.mutate({
                  sharesVesting: Number(sharesVesting),
                  fmvPerShareMinor: Math.round(Number(fmvPerShare) * 100),
                  jurisdiction: "US-CA",
                });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="sharesVesting">Shares vesting</Label>
                <Input
                  id="sharesVesting"
                  type="number"
                  min="1"
                  step="1"
                  value={sharesVesting}
                  onChange={(e) => setSharesVesting(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fmvPerShare">FMV per share (USD)</Label>
                <Input
                  id="fmvPerShare"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={fmvPerShare}
                  onChange={(e) => setFmvPerShare(e.target.value)}
                  required
                />
              </div>
              <div className="col-span-2">
                <Button type="submit" size="sm" disabled={calculator.isPending}>
                  {calculator.isPending ? "Computing…" : "Compute tax & strategies"}
                </Button>
              </div>
            </form>
            <p className="text-xs text-muted-foreground">
              Only US-CA is supported today — RSU vest income is withheld at the flat federal/state supplemental
              rate, not the employee's own progressive brackets.
            </p>

            {calculator.data && (
              <div className="space-y-3">
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p>
                    Gross value:{" "}
                    <span className="font-medium">
                      {formatMoney(calculator.data.tax.grossValueMinor / 100, "USD")}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    Total tax withheld:{" "}
                    <span className="font-medium text-foreground">
                      {formatMoney(calculator.data.tax.totalTaxMinor / 100, "USD")}
                    </span>
                  </p>
                </div>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Strategy</TableHead>
                        <TableHead className="text-right">Shares kept</TableHead>
                        <TableHead className="text-right">Cash out-of-pocket</TableHead>
                        <TableHead className="text-right">Net cash</TableHead>
                        <TableHead className="text-right">Retained value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calculator.data.strategies.map((s) => (
                        <TableRow key={s.strategy}>
                          <TableCell>
                            <Badge variant="outline">{STRATEGY_LABEL[s.strategy] ?? s.strategy}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{s.sharesRetained.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(s.cashOutlayMinor / 100, "USD")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(s.cashProceedsMinor / 100, "USD")}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(s.retainedValueMinor / 100, "USD")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
