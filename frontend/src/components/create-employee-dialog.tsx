import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod/v4";
// The *same* schema the Worker validates this payload with - imported, not
// re-declared, so a rule can never drift between client and server
// (design spec §6: one validation source, three entry points).
import { CreateEmployeeSchema } from "@shared/employee.schema";
import { useCreateEmployee } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type FormValues = z.input<typeof CreateEmployeeSchema>;

export function CreateEmployeeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createEmployee = useCreateEmployee();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateEmployeeSchema),
    defaultValues: {
      employeeNumber: "",
      firstName: "",
      lastName: "",
      email: "",
      country: "",
      department: "",
      jobTitle: "",
      level: "",
      hireDate: "",
      salary: { amount: "", currency: "", effectiveDate: "", reason: "hire" },
    } as unknown as FormValues,
  });

  async function onSubmit(values: FormValues) {
    await createEmployee.mutateAsync(values);
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add employee</DialogTitle>
          <DialogDescription>Creates the employee and their initial salary record.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" error={errors.firstName?.message}>
              <Input placeholder="Grace" {...register("firstName")} />
            </Field>
            <Field label="Last name" error={errors.lastName?.message}>
              <Input placeholder="Hopper" {...register("lastName")} />
            </Field>
          </div>
          <Field label="Email" error={errors.email?.message}>
            <Input type="email" placeholder="grace.hopper@company.com" {...register("email")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Employee number" error={errors.employeeNumber?.message}>
              <Input placeholder="EMP-0001" {...register("employeeNumber")} />
            </Field>
            <Field label="Hire date" error={errors.hireDate?.message}>
              <Input type="date" {...register("hireDate")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department" error={errors.department?.message}>
              <Input placeholder="Engineering" {...register("department")} />
            </Field>
            <Field label="Job title" error={errors.jobTitle?.message}>
              <Input placeholder="Senior Engineer" {...register("jobTitle")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Level" error={errors.level?.message}>
              <Input placeholder="L3" {...register("level")} />
            </Field>
            <Field label="Country" error={errors.country?.message}>
              <Input placeholder="US" maxLength={2} {...register("country")} />
            </Field>
          </div>

          <fieldset className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">Initial salary</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount" error={errors.salary?.amount?.message}>
                <Input type="number" step="0.01" placeholder="120000" {...register("salary.amount")} />
              </Field>
              <Field label="Currency" error={errors.salary?.currency?.message}>
                <Input placeholder="USD" maxLength={3} {...register("salary.currency")} />
              </Field>
            </div>
            <Field label="Effective date" error={errors.salary?.effectiveDate?.message}>
              <Input type="date" {...register("salary.effectiveDate")} />
            </Field>
            <input type="hidden" value="hire" {...register("salary.reason")} />
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create employee"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactElement<{ id?: string; "aria-invalid"?: boolean }>;
}) {
  // The control is given a generated id and the label points at it, so the
  // two are actually associated - a screen reader (and any test that finds
  // a field by its label) needs that link, which sibling elements don't
  // have on their own.
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {React.cloneElement(children, { id, "aria-invalid": error ? true : undefined })}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
