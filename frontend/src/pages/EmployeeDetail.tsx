import { Link, useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod/v4";
import { AddSalaryRecordSchema } from "@shared/employee.schema";
import { ArrowLeft } from "lucide-react";
import { useAddSalaryRecord, useEmployee, useTerminateEmployee } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ErrorState } from "@/components/error-state";
import { Field } from "@/components/create-employee-dialog";

type SalaryForm = z.input<typeof AddSalaryRecordSchema>;

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useOrg();
  const navigate = useNavigate();
  const { data, isPending, isError, refetch } = useEmployee(id);
  const terminate = useTerminateEmployee();

  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isPending) return <Skeleton className="h-64 w-full" />;

  const { employee, salaryHistory } = data;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/employees">
          <ArrowLeft />
          Back to employees
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {employee.firstName} {employee.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {employee.jobTitle} · {employee.department} · {employee.country}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={employee.employmentStatus === "active" ? "secondary" : "outline"}>
            {employee.employmentStatus}
          </Badge>
          {isAdmin && employee.employmentStatus === "active" && (
            // Destructive actions never fire from a bare button
            // (design spec §8).
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  Terminate
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Terminate this employee?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {employee.firstName} {employee.lastName} will be marked terminated. Their salary history
                    and audit trail are kept — this is not a deletion.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      await terminate.mutateAsync(employee.id);
                      navigate("/employees");
                    }}
                  >
                    Terminate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Employee number" value={employee.employeeNumber} mono />
            <Row label="Email" value={employee.email} />
            <Row label="Level" value={employee.level} />
            <Row label="Hire date" value={employee.hireDate} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Salary history</CardTitle>
            <CardDescription>Append-only — a raise adds a row, it never overwrites one.</CardDescription>
          </CardHeader>
          <CardContent>
            {salaryHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No salary records.</p>
            ) : (
              <ol className="relative space-y-4 border-l pl-5">
                {salaryHistory.map((s, i) => (
                  <li key={s.id} className="relative">
                    <span className="absolute -left-[1.4rem] top-1.5 size-2 rounded-full bg-primary" />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium tabular-nums">{formatMoney(s.amount, s.currency)}</p>
                      <Badge variant="outline">{s.reason}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Effective {s.effectiveDate}
                      {i === 0 && " · current"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {isAdmin && <AddSalaryForm employeeId={employee.id} />}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function AddSalaryForm({ employeeId }: { employeeId: string }) {
  const addSalary = useAddSalaryRecord(employeeId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SalaryForm>({
    resolver: zodResolver(AddSalaryRecordSchema),
    defaultValues: { amount: "", currency: "", effectiveDate: "", reason: "raise" } as unknown as SalaryForm,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add salary record</CardTitle>
        <CardDescription>Visible to admins only.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(async (values) => {
            await addSalary.mutateAsync(values);
            reset();
          })}
          className="grid gap-3 sm:grid-cols-4"
        >
          <Field label="Amount" error={errors.amount?.message}>
            <Input type="number" step="0.01" {...register("amount")} />
          </Field>
          <Field label="Currency" error={errors.currency?.message}>
            <Input placeholder="USD" maxLength={3} {...register("currency")} />
          </Field>
          <Field label="Effective date" error={errors.effectiveDate?.message}>
            <Input type="date" {...register("effectiveDate")} />
          </Field>
          <Field label="Reason" error={errors.reason?.message}>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              {...register("reason")}
            >
              <option value="raise">raise</option>
              <option value="adjustment">adjustment</option>
              <option value="correction">correction</option>
              <option value="hire">hire</option>
            </select>
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Add record"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
