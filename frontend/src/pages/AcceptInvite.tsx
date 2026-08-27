import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAcceptInvitation } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const accept = useAcceptInvitation();
  const { rememberOrg, memberships } = useOrg();
  const navigate = useNavigate();
  const [error, setError] = React.useState<string | null>(null);

  async function onAccept() {
    if (!token) return;
    setError(null);
    try {
      const result = await accept.mutateAsync(token);
      // The accept response carries the org id; the slug comes from the
      // refreshed membership list the mutation just invalidated.
      const joined = memberships.find((m) => m.organization.id === result.organizationId);
      if (joined) {
        rememberOrg(joined.organization.slug);
        navigate(`/${joined.organization.slug}/dashboard`, { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (err) {
      // The server distinguishes 404 (never existed) from 410 (expired,
      // already accepted, or revoked) - show whichever it said.
      setError(err instanceof Error ? err.message : "Could not accept this invitation");
    }
  }

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>Join organization</CardTitle>
          <CardDescription>You&apos;ve been invited to an organization.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" onClick={() => void onAccept()} disabled={accept.isPending || !token}>
            {accept.isPending ? "Joining…" : "Accept invitation"}
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => navigate("/")}>
            Cancel
          </Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
