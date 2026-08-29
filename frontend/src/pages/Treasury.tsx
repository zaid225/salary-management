import * as React from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTreasuryForecast } from "@/hooks/queries";
import { formatMoney } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

// Deterministic cash-flow forecast, zero AI (Rule #1 - LLMs never do math,
// and this is money math). "Starting cash balance" has no real bank
// integration behind it in this app - it's what the admin states the real
// account balance is today, forecast forward using only obligations this
// app actually knows about (see treasury-forecast.ts's scope note).
export function TreasuryPage() {
  const [balanceInput, setBalanceInput] = React.useState("");
  const startingCashBalanceMinor = balanceInput === "" ? null : Math.round(Number(balanceInput) * 100);
  const { data, isPending, isError, refetch } = useTreasuryForecast(startingCashBalanceMinor);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Treasury forecast"
        description="Deterministic cash prediction — starting balance minus known payroll obligations and EWA exposure, no AI in this calculation at all."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Current cash balance</CardTitle>
          <CardDescription>
            This app has no bank integration — enter the real balance as of today to forecast against it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="startingBalance">Balance (USD)</Label>
            <Input
              id="startingBalance"
              type="number"
              step="0.01"
              min="0"
              placeholder="500000.00"
              value={balanceInput}
              onChange={(e) => setBalanceInput(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {startingCashBalanceMinor === null ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Enter a balance above to see the forecast.
          </CardContent>
        </Card>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <ForecastCard
              label="Projected balance"
              sublabel="Known payroll obligations + pending EWA subtracted"
              balanceMinor={data.projectedBalanceMinor}
              atRisk={data.atRisk}
              shortfallMinor={data.shortfallMinor}
            />
            <ForecastCard
              label="Stress-test balance"
              sublabel="Also assumes every eligible employee maxes out EWA this month"
              balanceMinor={data.stressTestBalanceMinor}
              atRisk={data.stressAtRisk}
              shortfallMinor={data.stressShortfallMinor}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">What this is built from</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-y-2 text-sm sm:grid-cols-4">
                <dt className="text-muted-foreground">Starting balance</dt>
                <dd className="tabular-nums">{formatMoney(data.inputs.startingCashBalanceMinor / 100, "USD")}</dd>
                <dt className="text-muted-foreground">Known obligations</dt>
                <dd className="tabular-nums">
                  {formatMoney(data.inputs.knownObligationsMinor / 100, "USD")}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({data.inputs.calculatedRunCount} calculated run(s))
                  </span>
                </dd>
                <dt className="text-muted-foreground">Pending EWA</dt>
                <dd className="tabular-nums">
                  {formatMoney(data.inputs.pendingEwaMinor / 100, "USD")}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({data.inputs.pendingEwaCount} request(s))
                  </span>
                </dd>
                <dt className="text-muted-foreground">Additional EWA headroom</dt>
                <dd className="tabular-nums">{formatMoney(data.inputs.potentialAdditionalEwaMinor / 100, "USD")}</dd>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                EWA figures are for the current period ({data.inputs.periodStart} → {data.inputs.periodEnd}).
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function ForecastCard({
  label,
  sublabel,
  balanceMinor,
  atRisk,
  shortfallMinor,
}: {
  label: string;
  sublabel: string;
  balanceMinor: number;
  atRisk: boolean;
  shortfallMinor: number;
}) {
  return (
    <Card className={atRisk ? "border-destructive/50" : undefined}>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          {atRisk ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : (
            <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          )}
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold tracking-tight ${atRisk ? "text-destructive" : ""}`}>
          {formatMoney(balanceMinor / 100, "USD")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p>
        {atRisk && (
          <p className="mt-2 text-xs font-medium text-destructive">
            Shortfall of {formatMoney(shortfallMinor / 100, "USD")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
