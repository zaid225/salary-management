import { NavLink, Outlet } from "react-router-dom";
import { useClerk, useUser } from "@clerk/clerk-react";
import { BarChart3, ClipboardList, LogOut, Users, UsersRound } from "lucide-react";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OrgSwitcher } from "@/components/org-switcher";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { to: "/employees", label: "Employees", icon: Users },
  { to: "/members", label: "Members", icon: UsersRound, adminOnly: true },
  { to: "/audit-log", label: "Audit log", icon: ClipboardList },
];

export function AppLayout() {
  const { role, isAdmin } = useOrg();
  const { signOut } = useClerk();
  const { user } = useUser();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="p-4">
          <p className="text-sm font-semibold tracking-tight">Salary Management</p>
        </div>
        <div className="px-3 pb-3">
          <OrgSwitcher />
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60",
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "Signed in"}
            </span>
            {role && <Badge variant={role === "admin" ? "default" : "secondary"}>{role}</Badge>}
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void signOut()}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-7xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
