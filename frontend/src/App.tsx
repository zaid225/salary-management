import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SignedIn, SignedOut, useAuth } from "@clerk/clerk-react";
import { useOrg } from "@/lib/org-context";
import { AppLayout } from "@/components/app-layout";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SignInPage } from "@/pages/SignIn";
import { SignUpPage } from "@/pages/SignUp";
import { SsoCallbackPage } from "@/pages/SsoCallback";
import { OnboardingPage } from "@/pages/Onboarding";
import { AcceptInvitePage, takePendingInvite } from "@/pages/AcceptInvite";
import { DashboardPage } from "@/pages/Dashboard";
import { EmployeesPage } from "@/pages/Employees";
import { EmployeeDetailPage } from "@/pages/EmployeeDetail";
import { MembersPage } from "@/pages/Members";
import { AuditLogPage } from "@/pages/AuditLog";
import { ProfilePage } from "@/pages/Profile";
import { LedgerPage } from "@/pages/Ledger";

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in/*" element={<PublicOnly><SignInPage /></PublicOnly>} />
      <Route path="/sign-up/*" element={<PublicOnly><SignUpPage /></PublicOnly>} />
      <Route path="/sso-callback" element={<SsoCallbackPage />} />

      {/* Public on purpose: an invitation lands in the inbox of someone who
          may not have an account yet. The page itself handles the signed-out
          case and preserves the token across sign-in. */}
      <Route path="/accept-invite/:token" element={<AcceptInvitePage />} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />

      {/* The organization is part of the URL, so a link to a page is a link
          to that page for that organization - shareable and bookmarkable. */}
      <Route path="/:orgSlug" element={<RequireOrg />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="employees/:id" element={<EmployeeDetailPage />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="audit-log" element={<AuditLogPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="ledger" element={<LedgerPage />} />
      </Route>

      {/* A successful sign-in always resolves to somewhere real (§5 step 2). */}
      <Route path="/" element={<PostAuthGate />} />
    </Routes>
  );
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SignedOut>{children}</SignedOut>
      <SignedIn>
        <Navigate to="/" replace />
      </SignedIn>
    </>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

// Decides where an authenticated user lands: no orgs -> onboarding gate,
// otherwise the last-used org (or their first). A user never ends up back on
// the sign-in page or a blank shell after authenticating.
function PostAuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, memberships, defaultOrgSlug } = useOrg();

  if (!isLoaded || (isSignedIn && isLoading)) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;

  // Someone who arrived from an invitation link and had to authenticate first
  // gets taken back to it, rather than dumped on the onboarding gate being
  // asked to create an organization they were already invited to.
  const pendingInvite = takePendingInvite();
  if (pendingInvite) return <Navigate to={`/accept-invite/${pendingInvite}`} replace />;

  if (memberships.length === 0 || !defaultOrgSlug) return <Navigate to="/onboarding" replace />;
  return <Navigate to={`/${defaultOrgSlug}/dashboard`} replace />;
}

function RequireOrg() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, activeOrg, memberships, orgSlug } = useOrg();

  if (!isLoaded || (isSignedIn && isLoading)) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  if (memberships.length === 0) return <Navigate to="/onboarding" replace />;
  // A slug that isn't one of theirs is a distinct case from having no orgs:
  // a shared link to an org they aren't in, or a typo. Say so rather than
  // silently bouncing them somewhere else.
  if (!activeOrg) return <UnknownOrg slug={orgSlug} />;
  return <AppLayout />;
}

function UnknownOrg({ slug }: { slug: string | null }) {
  const { defaultOrgSlug } = useOrg();
  const location = useLocation();
  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>Organization not found</CardTitle>
          <CardDescription>
            You&apos;re not a member of <code className="font-mono">{slug ?? location.pathname}</code>, or it
            doesn&apos;t exist.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {defaultOrgSlug && (
            <Button asChild className="w-full">
              <a href={`/${defaultOrgSlug}/dashboard`}>Go to your organization</a>
            </Button>
          )}
          <Button variant="outline" className="w-full" asChild>
            <a href="/onboarding">Create or join one</a>
          </Button>
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function LoadingScreen() {
  return (
    <AuthShell>
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </AuthShell>
  );
}
