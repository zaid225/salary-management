import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import { AuthShell } from "@/components/auth-shell";

// Thin route that finishes the Google handshake and forwards into the same
// post-auth gate email sign-in uses (design spec §7).
export function SsoCallbackPage() {
  return (
    <AuthShell>
      <div className="text-center text-sm text-muted-foreground">Completing sign-in…</div>
      <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" />
    </AuthShell>
  );
}
