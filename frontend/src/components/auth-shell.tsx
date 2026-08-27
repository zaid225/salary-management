export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Salary Management</h1>
          <p className="text-sm text-muted-foreground">Multi-tenant compensation data</p>
        </div>
        {children}
      </div>
    </div>
  );
}
