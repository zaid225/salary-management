import * as React from "react";
import { useAuth } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import { createApiClient, type ApiClient } from "./api";
import type { OrganizationMembership, Role } from "./types";

const ACTIVE_ORG_KEY = "activeOrganizationId";

interface OrgContextValue {
  api: ApiClient;
  memberships: OrganizationMembership[];
  isLoading: boolean;
  activeOrgId: string | null;
  setActiveOrgId: (id: string) => void;
  activeOrg: OrganizationMembership | null;
  role: Role | null;
  isAdmin: boolean;
}

const OrgContext = React.createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  // The token getter is stable per-session; the api client closes over it so
  // no component ever handles a raw token itself.
  const api = React.useMemo(
    () => createApiClient(async () => (isSignedIn ? await getToken() : null)),
    [getToken, isSignedIn],
  );

  const [activeOrgId, setActiveOrgIdState] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_ORG_KEY);
    } catch {
      // Private mode / storage disabled - fall back to picking the first org.
      return null;
    }
  });

  const { data, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api.request<{ organizations: OrganizationMembership[] }>("/api/organizations?limit=100"),
    enabled: Boolean(isSignedIn),
  });

  const memberships = React.useMemo(() => data?.organizations ?? [], [data]);

  const setActiveOrgId = React.useCallback((id: string) => {
    setActiveOrgIdState(id);
    try {
      localStorage.setItem(ACTIVE_ORG_KEY, id);
    } catch {
      // Non-fatal: the choice just won't survive a reload.
    }
  }, []);

  // A stored org id from a previous session may name an org this user has
  // since been removed from - fall back rather than sending an X-Org-Id the
  // API will 403.
  React.useEffect(() => {
    if (memberships.length === 0) return;
    const stillAMember = memberships.some((m) => m.organization.id === activeOrgId);
    if (!stillAMember) {
      const first = memberships[0];
      if (first) setActiveOrgId(first.organization.id);
    }
  }, [memberships, activeOrgId, setActiveOrgId]);

  const activeOrg = memberships.find((m) => m.organization.id === activeOrgId) ?? null;

  const value: OrgContextValue = {
    api,
    memberships,
    isLoading,
    activeOrgId: activeOrg ? activeOrg.organization.id : null,
    setActiveOrgId,
    activeOrg,
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
