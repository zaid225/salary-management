// A mark rather than a stock icon: three bars stepping upward inside a
// rounded square, reading as both a salary band chart and a payslip. Uses
// currentColor so it inherits whatever it sits on, in either theme.
export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="currentColor" opacity="0.12" />
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="6" y="14" width="3" height="4.5" rx="1" fill="currentColor" />
      <rect x="10.5" y="10.5" width="3" height="8" rx="1" fill="currentColor" />
      <rect x="15" y="5.5" width="3" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function LogoWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <Logo className="size-5 shrink-0" />
      <span className="truncate text-sm font-semibold tracking-tight">Salary Management</span>
    </span>
  );
}
