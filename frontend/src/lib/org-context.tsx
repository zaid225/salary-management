import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { createApiClient, type ApiClient } from "./api";
import type { OrganizationMembership, Role } from "./types";

const LAST_ORG_KEY = "lastOrganizationSlug";

// Top-level paths that are not an organization slug.
const RESERVED_SEGMENTS = new Set(["sign-in", "sign-up", "sso-callback", "onboarding", "accept-invite"]);

interface OrgContextValue {
  api: ApiClient;
  memberships: OrganizationMembership[];
  isLoading: boolean;
  activeOrgId: string | null;
  activeOrg: OrganizationMembership | null;
  /** Slug of the org the URL is scoped to, or null outside org routes. */
  orgSlug: string | null;
  /** Navigates to the same page under a different organization. */
  switchOrg: (slug: string) => void;
  rememberOrg: (slug: string) => void;
  /** The slug to land on after sign-in: last used if still a member, else the first. */
  defaultOrgSlug: string | null;
  role: Role | null;
  isAdmin: boolean;
}

const OrgContext = React.createContext<OrgContextValue | null>(null);

function readLastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();
  const navigate = useNavigate();
  // The org lives in the URL (/:orgSlug/dashboard), so a link to a page is a
  // link to that page *for that organization* - shareable, bookmarkable, and
  // it survives a reload without depending on localStorage. localStorage is
  // now only a convenience for picking where to land after sign-in.
  //
  // Read from the pathname rather than useParams: this provider sits above
  // <Routes> so that non-org pages (onboarding, accept-invite) can still list
  // the user's organizations, and useParams returns {} outside a route match.
  const { pathname } = useLocation();
  const orgSlug = React.useMemo(() => {
    const first = pathname.split("/")[1] ?? "";
    return first === "" || RESERVED_SEGMENTS.has(first) ? null : first;
  }, [pathname]);

  const api = React.useMemo(
    () => createApiClient(async () => (isSignedIn ? await getToken() : null)),
    [getToken, isSignedIn],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api.request<{ organizations: OrganizationMembership[] }>("/api/organizations?limit=100"),
    enabled: Boolean(isSignedIn),
  });

  const memberships = React.useMemo(() => data?.organizations ?? [], [data]);

  const rememberOrg = React.useCallback((slug: string) => {
    try {
      localStorage.setItem(LAST_ORG_KEY, slug);
    } catch {
      // Non-fatal: the choice just won't survive a reload.
    }
  }, []);

  const activeOrg = React.useMemo(
    () => memberships.find((m) => m.organization.slug === orgSlug) ?? null,
    [memberships, orgSlug],
  );

  // Keep "where to land next time" in step with where they actually are.
  React.useEffect(() => {
    if (activeOrg) rememberOrg(activeOrg.organization.slug);
  }, [activeOrg, rememberOrg]);

  const switchOrg = React.useCallback(
    (slug: string) => {
      rememberOrg(slug);
      // Stay on the equivalent page in the new org rather than always
      // bouncing to the dashboard.
      const rest = pathname.split("/").slice(2).join("/");
      navigate(`/${slug}/${rest || "dashboard"}`);
    },
    [navigate, rememberOrg, pathname],
  );

  const defaultOrgSlug = React.useMemo(() => {
    if (memberships.length === 0) return null;
    const last = readLastOrg();
    // A remembered org the user has since been removed from must not win.
    if (last && memberships.some((m) => m.organization.slug === last)) return last;
    return memberships[0]?.organization.slug ?? null;
  }, [memberships]);

  const value: OrgContextValue = {
    api,
    memberships,
    isLoading,
    activeOrgId: activeOrg?.organization.id ?? null,
    activeOrg,
    orgSlug,
    switchOrg,
    rememberOrg,
    defaultOrgSlug,
    role: activeOrg?.role ?? null,
    isAdmin: activeOrg?.role === "admin",
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = React.useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used inside <OrgProvider>");
  return ctx;
}
