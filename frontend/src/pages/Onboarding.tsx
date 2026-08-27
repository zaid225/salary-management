import * as React from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useCreateOrganization } from "@/hooks/queries";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOrg } from "@/lib/org-context";
import type { Organization } from "@/lib/types";

// The gate shown whenever there's no active organization. Nothing past this
// screen is reachable without one (design spec §5 step 4, §7).
export function OnboardingPage() {
  const [name, setName] = React.useState("");
  const [inviteUrl, setInviteUrl] = React.useState("");
  // Creating an org used to drop the user straight onto an empty dashboard
  // with no acknowledgement that anything happened. Confirm it first, and
  // show the slug their URLs will now carry.
  const [created, setCreated] = React.useState<Organization | null>(null);
  const createOrg = useCreateOrganization();
  const { rememberOrg, memberships } = useOrg();
  const navigate = useNavigate();

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const result = await createOrg.mutateAsync({ name });
    rememberOrg(result.organization.slug);
    setCreated(result.organization);
  }

  function goToDashboard() {
    if (!created) return;
    navigate(`/${created.slug}/dashboard`, { replace: true });
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

      {memberships.length > 0 && !created && (
        <Button variant="ghost" className="w-full" onClick={() => navigate("/")}>
          Back to dashboard
        </Button>
      )}

      <Dialog open={created !== null} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5" />
              Organization created
            </DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">{created?.name}</strong> is ready and you&apos;re its admin.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div className="rounded-md bg-muted p-3">
              <p className="text-xs text-muted-foreground">Its pages live under</p>
              <code className="mt-0.5 block break-all font-mono text-xs">/{created?.slug}/dashboard</code>
            </div>
            <p className="text-muted-foreground">
              Add employees by hand or import a CSV, then invite the rest of your team from the Members page.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreated(null)}>
              Stay here
            </Button>
            <Button onClick={goToDashboard}>Go to dashboard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthShell>
  );
}
