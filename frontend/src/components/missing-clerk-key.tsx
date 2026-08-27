import { AuthShell } from "@/components/auth-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Shown instead of a blank white screen when VITE_CLERK_PUBLISHABLE_KEY
// isn't set. Clerk cannot be stubbed out - it issues the session token the
// API authenticates with - so this states the one setup step plainly.
export function MissingClerkKey() {
  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>Clerk isn&apos;t configured</CardTitle>
          <CardDescription>One setup step is needed before the app can sign anyone in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Create <code className="rounded bg-muted px-1 py-0.5 text-xs">frontend/.env</code> with:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {`VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_URL=http://localhost:8787`}
          </pre>
          <p className="text-muted-foreground">
            In the Clerk dashboard, also enable the Google social connection and add this origin to the
            allowed redirect URLs, so <code className="rounded bg-muted px-1 py-0.5 text-xs">/sso-callback</code>{" "}
            resolves.
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
