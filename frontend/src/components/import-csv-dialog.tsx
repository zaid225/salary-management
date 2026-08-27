import * as React from "react";
import { useImportCsv } from "@/hooks/queries";
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
import type { ImportResult } from "@/lib/types";

const EXPECTED_HEADER =
  "employeeNumber,firstName,lastName,email,country,department,jobTitle,level,hireDate,salaryAmount,salaryCurrency";

export function ImportCsvDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const importCsv = useImportCsv();
  const [result, setResult] = React.useState<ImportResult | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    const text = await file.text();
    const res = await importCsv.mutateAsync(text);
    // Per-row failures are reported inline rather than thrown away - the
    // import itself succeeded for every row that was well-formed.
    setResult(res);
  }

  function close() {
    setResult(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import employees from CSV</DialogTitle>
          <DialogDescription>
            Existing employee numbers update the profile only — salaries are never changed by an import.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="csv">CSV file</Label>
            <Input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} />
          </div>

          <div className="rounded-md bg-muted p-3">
            <p className="text-xs font-medium">Expected header</p>
            <code className="mt-1 block overflow-x-auto whitespace-pre text-xs text-muted-foreground">
              {EXPECTED_HEADER}
            </code>
          </div>

          {importCsv.isPending && <p className="text-sm text-muted-foreground">Importing…</p>}

          {result && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm">
                <span className="font-medium">{result.created}</span> created,{" "}
                <span className="font-medium">{result.updated}</span> updated,{" "}
                <span className="font-medium">{result.failed.length}</span> failed
              </p>
              {result.failed.length > 0 && (
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-2">Row</th>
                        <th className="py-1">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.failed.map((f) => (
                        <tr key={f.row} className="border-t">
                          <td className="py-1 pr-2 font-mono">{f.row}</td>
                          <td className="py-1 text-destructive">{f.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {result ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
