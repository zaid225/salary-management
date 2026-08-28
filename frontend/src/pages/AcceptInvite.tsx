import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { useAcceptInvitation } from "@/hooks/queries";
import { useOrg } from "@/lib/org-context";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PENDING_INVITE_KEY = "pendingInviteToken";

export function rememberPendingInvite(token: string): void {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, token);
  } catch {
    // Non-fatal: the invitee just has to click the emailed link again.
  }
}

export function takePendingInvite(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (token) sessionStorage.removeItem(PENDING_INVITE_KEY);
    return token;
  } catch {
    return null;
  }
}

/**
 * Reachable signed out, on purpose.
 *
 * An invitation is the one link that arrives in the inbox of someone who has
 * no account yet. Gating this page behind auth sent them to sign-in and threw
 * the token away, so the invite could never actually be redeemed by a new
 * person. Now the page always renders; if they are signed out it holds the
 * token and hands them to sign-in or sign-up, and the post-auth gate brings
 * them straight back here.
 */
export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const { isLoaded, isSignedIn } = useAuth();
  const accept = useAcceptInvitation();
  const { rememberOrg, memberships } = useOrg();
  const navigate = useNavigate();
  const [error, setError] = React.useState<string | null>(null);

  async function onAccept() {
    if (!token) return;
    setError(null);
    try {
      const result = await accept.mutateAsync(token);
      const joined = memberships.find((m) => m.organization.id === result.organizationId);
      if (joined) {
        rememberOrg(joined.organization.slug);
        navigate(`/${joined.organization.slug}/dashboard`, { replace: true });
      } else {
        // The membership list refreshes a moment behind the accept call; the
        // post-auth gate resolves where to land either way.
        navigate("/", { replace: true });
      }
    } catch (err) {
      // The server distinguishes 404 (never existed) from 410 (expired,
      // already accepted, or revoked) - show whichever it said.
      setError(err instanceof Error ? err.message : "Could not accept this invitation");
    }
  }

  function goAuthenticate(path: "/sign-in" | "/sign-up") {
    if (token) rememberPendingInvite(token);
    navigate(path);
  }

  if (!isLoaded) {
    return (
      <AuthShell>
        <Skeleton className="h-40 w-full" />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>You&apos;ve been invited</CardTitle>
          <CardDescription>
            {isSignedIn
              ? "Accept to join this organization."
              : "Sign in or create an account to accept this invitation."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {isSignedIn ? (
            <>
              <Button className="w-full" onClick={() => void onAccept()} disabled={accept.isPending || !token}>
                {accept.isPending ? "Joining…" : "Accept invitation"}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => navigate("/")}>
                Not now
              </Button>
            </>
          ) : (
            <>
              <Button className="w-full" onClick={() => goAuthenticate("/sign-up")}>
                Create an account
              </Button>
              <Button variant="outline" className="w-full" onClick={() => goAuthenticate("/sign-in")}>
                I already have an account
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                We&apos;ll bring you straight back here once you&apos;re signed in.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}
