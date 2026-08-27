import * as React from "react";
import { useSignIn } from "@clerk/clerk-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GoogleIcon } from "@/components/google-icon";
import { AuthShell } from "@/components/auth-shell";

// Every pixel here is ours - Clerk is the identity backend only, reached
// through its headless hooks. No hosted <SignIn/> component anywhere in the
// app (design spec §5, §7).
export function SignInPage() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        // §5 step 2: a successful sign-in always lands somewhere real - the
        // post-auth gate decides dashboard vs onboarding.
        navigate("/", { replace: true });
      } else {
        setError("Additional verification is required to finish signing in.");
      }
    } catch (err) {
      setError(clerkErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onGoogle() {
    if (!isLoaded || !signIn) return;
    setError(null);
    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/",
      });
    } catch (err) {
      setError(clerkErrorMessage(err));
    }
  }

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Access your organization&apos;s salary data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button type="button" variant="outline" className="w-full" onClick={onGoogle} disabled={!isLoaded}>
            <GoogleIcon />
            Continue with Google
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting || !isLoaded}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link to="/sign-up" className="text-foreground underline underline-offset-4">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export function clerkErrorMessage(err: unknown): string {
  const errors = (err as { errors?: { longMessage?: string; message?: string }[] })?.errors;
  const first = errors?.[0];
  if (first) return first.longMessage ?? first.message ?? "Authentication failed";
  if (err instanceof Error) return err.message;
  return "Authentication failed";
}
