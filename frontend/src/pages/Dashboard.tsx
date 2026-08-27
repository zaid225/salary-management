import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import * as React from "react";
import { FileDown } from "lucide-react";
import { toast } from "sonner";
import { useAnalytics } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { useUser } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/error-state";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function DashboardPage() {
  const { data, isPending, isError, refetch } = useAnalytics();
  const { activeOrg } = useOrg();
  const { user } = useUser();
  const deptChartRef = React.useRef<HTMLDivElement>(null);
  const countryChartRef = React.useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = React.useState(false);

  async function onExportPdf() {
    if (!data) return;
    setExporting(true);
    try {
      // The charts are captured from the rendered DOM rather than redrawn,
      // so the report can never disagree with the dashboard it came from.
      const nodes = [deptChartRef.current, countryChartRef.current].filter(
        (n): n is HTMLDivElement => n !== null,
      );
      // Loaded on demand: jspdf + html2canvas are ~650 kB, and most visits
      // to this dashboard never export anything.
      const { buildSalaryReport } = await import("@/lib/pdf-report");
      const blob = await buildSalaryReport(data, nodes, {
        orgName: activeOrg?.organization.name ?? "Organization",
        generatedBy: user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "unknown",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `salary-report-${activeOrg?.organization.slug ?? "org"}-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build the report");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="How this organization pays people, normalized to USD."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onExportPdf()}
            disabled={exporting || isPending || isError || !data || data.headcount === 0}
          >
            <FileDown />
            {exporting ? "Building report…" : "Export PDF report"}
          </Button>
        }
      />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Headcount" value={data.headcount.toLocaleString()} />
            <StatCard label="Average salary" value={formatUsd(data.avgUsd)} />
            <StatCard label="Median salary" value={formatUsd(data.medianUsd)} />
            <StatCard label="Total payroll cost" value={formatUsd(data.totalCostUsd)} />
          </div>

          {data.headcount === 0 && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                No salary data to summarize yet. Note that employees paid in a currency with no FX rate on
                record are excluded from these figures rather than counted at par.
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Average salary by department</CardTitle>
                <CardDescription>USD-normalized, active employees only</CardDescription>
              </CardHeader>
              <CardContent className="h-72" ref={deptChartRef}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byDepartment} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="department"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--muted)" }}
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius)",
                        color: "var(--popover-foreground)",
                        fontSize: 12,
                      }}
                      formatter={(v: number) => [formatUsd(v), "Avg salary"]}
                    />
                    <Bar dataKey="avgUsd" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Headcount by country</CardTitle>
                <CardDescription>Active employees</CardDescription>
              </CardHeader>
              <CardContent className="h-72" ref={countryChartRef}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.byCountry}
                      dataKey="headcount"
                      nameKey="country"
                      innerRadius={55}
                      outerRadius={95}
                      paddingAngle={2}
                    >
                      {data.byCountry.map((entry, i) => (
                        <Cell key={entry.country} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius)",
                        color: "var(--popover-foreground)",
                        fontSize: 12,
                      }}
                      formatter={(v: number, n: string) => [`${v} employees`, n]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By level</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
                {data.byLevel.map((l) => (
                  <div key={l.level} className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{l.level}</p>
                    <p className="text-sm font-medium">{formatUsd(l.avgUsd)}</p>
                    <p className="text-xs text-muted-foreground">{l.headcount} people</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}
