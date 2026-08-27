import { Building2, ChevronsUpDown, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useOrg } from "@/lib/org-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

// Custom-built, deliberately not Clerk's <OrganizationSwitcher/> - orgs are
// our own tables, not Clerk's Organization primitive (design spec §1, §7).
export function OrgSwitcher() {
  const { memberships, activeOrg, switchOrg } = useOrg();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full justify-between px-2 font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <Building2 className="size-4 shrink-0" />
            <span className="truncate">{activeOrg?.organization.name ?? "Select organization"}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.organization.id}
            onSelect={() => switchOrg(m.organization.slug)}
            className="justify-between"
          >
            <span className="truncate">{m.organization.name}</span>
            <span className="text-xs text-muted-foreground">{m.role}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/onboarding")}>
          <Plus className="size-4" />
          New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
