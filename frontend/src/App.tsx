import { Navigate, Route, Routes } from "react-router-dom";
import { SignedIn, SignedOut, useAuth } from "@clerk/clerk-react";
import { useOrg } from "@/lib/org-context";
import { AppLayout } from "@/components/app-layout";
import { AuthShell } from "@/components/auth-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { SignInPage } from "@/pages/SignIn";
import { SignUpPage } from "@/pages/SignUp";
import { SsoCallbackPage } from "@/pages/SsoCallback";
import { OnboardingPage } from "@/pages/Onboarding";
import { AcceptInvitePage } from "@/pages/AcceptInvite";
import { DashboardPage } from "@/pages/Dashboard";
import { EmployeesPage } from "@/pages/Employees";
import { EmployeeDetailPage } from "@/pages/EmployeeDetail";
import { MembersPage } from "@/pages/Members";
import { AuditLogPage } from "@/pages/AuditLog";

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in/*" element={<PublicOnly><SignInPage /></PublicOnly>} />
      <Route path="/sign-up/*" element={<PublicOnly><SignUpPage /></PublicOnly>} />
      <Route path="/sso-callback" element={<SsoCallbackPage />} />

      <Route path="/accept-invite/:token" element={<RequireAuth><AcceptInvitePage /></RequireAuth>} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />

      {/* Everything below needs both a session and an active organization. */}
      <Route element={<RequireOrg />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/employees/:id" element={<EmployeeDetailPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/audit-log" element={<AuditLogPage />} />
      </Route>

      {/* §5 step 2: a successful sign-in always resolves to somewhere real. */}
      <Route path="/" element={<PostAuthGate />} />
      <Route path="*" element={<Navigate to="/" replace />} />
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

// Decides where an authenticated user actually lands: no orgs -> onboarding
// gate, otherwise the dashboard for the active (or first) org. A user never
// ends up back on the sign-in page or a blank shell after authenticating.
function PostAuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, memberships } = useOrg();

  if (!isLoaded || (isSignedIn && isLoading)) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  if (memberships.length === 0) return <Navigate to="/onboarding" replace />;
  return <Navigate to="/dashboard" replace />;
}

function RequireOrg() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isLoading, activeOrgId } = useOrg();

  if (!isLoaded || (isSignedIn && isLoading)) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  if (!activeOrgId) return <Navigate to="/onboarding" replace />;
  return <AppLayout />;
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
