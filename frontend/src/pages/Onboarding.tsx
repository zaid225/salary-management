import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useCreateOrganization } from "@/hooks/queries";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrg } from "@/lib/org-context";

// The gate shown whenever there's no active organization. Nothing past this
// screen is reachable without one (design spec §5 step 4, §7).
export function OnboardingPage() {
  const [name, setName] = React.useState("");
  const [inviteUrl, setInviteUrl] = React.useState("");
  const createOrg = useCreateOrganization();
  const { setActiveOrgId, memberships } = useOrg();
  const navigate = useNavigate();

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const result = await createOrg.mutateAsync({ name });
    setActiveOrgId(result.organization.id);
    navigate("/dashboard", { replace: true });
  }

  function onRedeem(e: React.FormEvent) {
    e.preventDefault();
    // Accepts either a full invite link or a bare token, since an admin may
    // paste whichever they have to hand.
    const token = inviteUrl.trim().split("/").filter(Boolean).pop();
    if (token) navigate(`/accept-invite/${token}`);
  }

  return (
    <AuthShell>
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>You&apos;ll be its first admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="orgName">Organization name</Label>
              <Input
                id="orgName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ACME Corp"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={createOrg.isPending || name.trim() === ""}>
              {createOrg.isPending ? "Creating…" : "Create organization"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Have an invite link?</CardTitle>
          <CardDescription>Paste it to join an existing organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onRedeem} className="flex gap-2">
            <Input
              value={inviteUrl}
              onChange={(e) => setInviteUrl(e.target.value)}
              placeholder="https://…/accept-invite/token"
            />
            <Button type="submit" variant="outline" disabled={inviteUrl.trim() === ""}>
              Join
            </Button>
          </form>
        </CardContent>
      </Card>

      {memberships.length > 0 && (
        <Button variant="ghost" className="w-full" onClick={() => navigate("/dashboard")}>
          Back to dashboard
        </Button>
      )}
    </AuthShell>
  );
}
