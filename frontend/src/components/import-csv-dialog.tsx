import * as React from "react";
import { AlertCircle, CheckCircle2, FileText, Upload, X } from "lucide-react";
import { useImportCsv } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportResult } from "@/lib/types";

const EXPECTED_COLUMNS = [
  "employeeNumber",
  "firstName",
  "lastName",
  "email",
  "country",
  "department",
  "jobTitle",
  "level",
  "hireDate",
  "salaryAmount",
  "salaryCurrency",
];

interface Picked {
  name: string;
  size: number;
  text: string;
  dataRows: number;
  missingColumns: string[];
}

function inspect(name: string, size: number, text: string): Picked {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  return {
    name,
    size,
    text,
    dataRows: Math.max(lines.length - 1, 0),
    // Caught here rather than as 10,000 identical per-row errors from the
    // server: a header typo is one mistake, not one mistake per row.
    missingColumns: EXPECTED_COLUMNS.filter((c) => !header.includes(c)),
  };
}

export function ImportCsvDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const importCsv = useImportCsv();
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function take(file: File | undefined) {
    if (!file) return;
    setResult(null);
    setPicked(inspect(file.name, file.size, await file.text()));
  }

  function reset() {
    setPicked(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  const canImport = picked !== null && picked.dataRows > 0 && picked.missingColumns.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import employees</DialogTitle>
          <DialogDescription>
            New employee numbers are created with their salary. Existing ones have their profile updated —
            an import never changes anyone&apos;s pay.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!result && (
            <>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void take(e.dataTransfer.files[0]);
                }}
                className={`rounded-lg border border-dashed p-6 text-center transition-colors ${
                  dragging ? "border-primary bg-accent" : "border-input"
                }`}
              >
                <Upload className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 text-sm">
                  Drop a CSV here, or{" "}
                  <button
                    type="button"
                    className="text-foreground underline underline-offset-4"
                    onClick={() => inputRef.current?.click()}
                  >
                    browse
                  </button>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Up to 5 MB</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(e) => void take(e.target.files?.[0])}
                />
              </div>

              {picked && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{picked.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {picked.dataRows.toLocaleString()} rows · {(picked.size / 1024).toFixed(0)} KB
                    </span>
                    <Button type="button" variant="ghost" size="icon" className="size-7" onClick={reset}>
                      <X className="size-4" />
                    </Button>
                  </div>

                  {picked.missingColumns.length > 0 && (
                    <p className="flex items-start gap-1.5 text-xs text-destructive">
                      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                      <span>Missing column{picked.missingColumns.length > 1 ? "s" : ""}: {picked.missingColumns.join(", ")}</span>
                    </p>
                  )}
                  {picked.dataRows === 0 && (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertCircle className="size-3.5 shrink-0" />
                      This file has a header but no data rows.
                    </p>
                  )}
                </div>
              )}

              <details className="rounded-md bg-muted p-3">
                <summary className="cursor-pointer text-xs font-medium">Expected columns</summary>
                <code className="mt-2 block overflow-x-auto whitespace-pre text-xs text-muted-foreground">
                  {EXPECTED_COLUMNS.join(",")}
                </code>
              </details>
            </>
          )}

          {result && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Created" value={result.created} tone="good" />
                <Stat label="Updated" value={result.updated} tone="good" />
                <Stat label="Failed" value={result.failed.length} tone={result.failed.length ? "bad" : "muted"} />
              </div>

              {result.failed.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4" />
                  Every row imported cleanly.
                </p>
              ) : (
                <div className="rounded-md border">
                  <p className="border-b px-3 py-2 text-xs font-medium">
                    Rows that failed — everything else was still imported
                  </p>
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {result.failed.map((f) => (
                          <tr key={f.row} className="border-b last:border-0">
                            <td className="w-16 px-3 py-1.5 font-mono text-muted-foreground">#{f.row}</td>
                            <td className="px-3 py-1.5 text-destructive">{f.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <>
              <Button variant="outline" onClick={reset}>
                Import another
              </Button>
              <Button onClick={close}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!canImport || importCsv.isPending}
                onClick={async () => {
                  if (!picked) return;
                  setResult(await importCsv.mutateAsync(picked.text));
                }}
              >
                {importCsv.isPending
                  ? "Importing…"
                  : picked
                    ? `Import ${picked.dataRows.toLocaleString()} rows`
                    : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "good" | "bad" | "muted" }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <p
        className={`text-xl font-semibold tabular-nums ${
          tone === "bad" ? "text-destructive" : tone === "good" ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
