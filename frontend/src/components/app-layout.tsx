import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useClerk, useUser } from "@clerk/clerk-react";
import {
  BarChart3,
  ClipboardList,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OrgSwitcher } from "@/components/org-switcher";

// Paths are relative to the org segment - see NavLink's `to` below.
const NAV = [
  { to: "dashboard", label: "Dashboard", icon: BarChart3 },
  { to: "employees", label: "Employees", icon: Users },
  { to: "members", label: "Members", icon: UsersRound, adminOnly: true },
  { to: "audit-log", label: "Audit log", icon: ClipboardList },
];

const COLLAPSED_KEY = "sidebarCollapsed";

export function AppLayout() {
  const { role, isAdmin, orgSlug } = useOrg();
  const { signOut } = useClerk();
  const { user } = useUser();
  const location = useLocation();

  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = React.useState(false);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Non-fatal: the preference just won't survive a reload.
      }
      return next;
    });
  }

  // Navigating on mobile should close the drawer, otherwise it covers the
  // page the user just asked for.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const items = NAV.filter((item) => !item.adminOnly || isAdmin);

  const sidebar = (
    <>
      <div className={cn("flex items-center gap-2 p-4", collapsed && "justify-center px-2")}>
        {!collapsed && <p className="flex-1 truncate text-sm font-semibold tracking-tight">Salary Management</p>}
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 shrink-0 md:inline-flex"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
        >
          <X className="size-4" />
        </Button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-3">
          <OrgSwitcher />
        </div>
      )}

      {/* Only this list scrolls when there are more items than fit - the
          header and the footer below stay pinned. */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={`/${orgSlug}/${item.to}`}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                collapsed && "justify-center px-0",
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60",
              )
            }
          >
            <item.icon className="size-4 shrink-0" />
            {!collapsed && item.label}
          </NavLink>
        ))}
      </nav>

      <div className="shrink-0 space-y-2 border-t p-3">
        {!collapsed && (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "Signed in"}
            </span>
            {role && <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full justify-start", collapsed && "justify-center px-0")}
          onClick={() => void signOut()}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className="size-4 shrink-0" />
          {!collapsed && "Sign out"}
        </Button>
      </div>
    </>
  );

  return (
    // h-screen + overflow-hidden on the shell is what stops the page from
    // scrolling as one block and taking the sidebar with it. The sidebar and
    // the main column each own their scrolling from here.
    <div className="flex h-screen overflow-hidden">
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-sidebar">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile needs its own way in - the sidebar is hidden at this
            breakpoint, so without this there is no navigation at all. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-4" />
          </Button>
          <span className="text-sm font-semibold tracking-tight">Salary Management</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
