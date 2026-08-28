import * as React from "react";
import { Input } from "@/components/ui/input";

// A native <datalist> rather than a custom popover: it gives a real dropdown
// of the values this organization already uses while still accepting a new
// one. A hard <select> would make adding the first person in a new department
// impossible; a plain text box is how you end up with "Enginering" sitting
// next to "Engineering" in the analytics breakdown.
export const ComboInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { options: string[]; listId: string }
>(({ options, listId, ...props }, ref) => (
  <>
    <Input ref={ref} list={listId} autoComplete="off" {...props} />
    <datalist id={listId}>
      {options.map((o) => (
        <option key={o} value={o} />
      ))}
    </datalist>
  </>
));
ComboInput.displayName = "ComboInput";

// ISO-3166 alpha-2 for the countries this product realistically covers, with
// names resolved by the platform rather than hand-maintained in a table here.
const COUNTRY_CODES = [
  "AE", "AR", "AT", "AU", "BE", "BR", "CA", "CH", "CL", "CN", "CO", "CZ", "DE", "DK", "EG", "ES",
  "FI", "FR", "GB", "GR", "HK", "HU", "ID", "IE", "IL", "IN", "IT", "JP", "KE", "KR", "MX", "MY",
  "NG", "NL", "NO", "NZ", "PH", "PL", "PT", "RO", "SA", "SE", "SG", "TH", "TR", "TW", "UA", "US",
  "VN", "ZA",
];

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function countryLabel(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ code, label: countryLabel(code) })).sort(
  (a, b) => a.label.localeCompare(b.label),
);

export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${className ?? ""}`}
    {...props}
  >
    {children}
  </select>
));
NativeSelect.displayName = "NativeSelect";
