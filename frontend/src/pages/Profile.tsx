import * as React from "react";
import { useUser } from "@clerk/clerk-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { useOrg } from "@/lib/org-context";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/avatar";
import { clerkErrorMessage } from "@/pages/SignIn";

// Our own profile UI on Clerk's headless hooks - no hosted <UserProfile/>,
// same rule the sign-in and sign-up pages follow.
export function ProfilePage() {
  const { user, isLoaded } = useUser();
  const { memberships, activeOrg } = useOrg();
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (user) {
      setFirstName(user.firstName ?? "");
      setLastName(user.lastName ?? "");
    }
  }, [user]);

  if (!isLoaded || !user) return null;

  const dirty = firstName !== (user.firstName ?? "") || lastName !== (user.lastName ?? "");

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    try {
      await user.update({ firstName, lastName });
      // The API keeps its own users mirror; it re-reads from Clerk when a row
      // is missing, so the member list picks this up without a webhook.
      toast.success("Profile updated");
    } catch (err) {
      toast.error(clerkErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function onAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setUploading(true);
    try {
      await user.setProfileImage({ file });
      toast.success("Photo updated");
    } catch (err) {
      toast.error(clerkErrorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Your profile" description="How you appear to everyone else in your organizations." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Photo</CardTitle>
            <CardDescription>Shown next to your name on the Members page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Avatar
              name={user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "?"}
              src={user.imageUrl}
              hasImage={user.hasImage}
              className="size-20 text-lg"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => void onAvatar(e)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Change photo"}
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSave} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    placeholder="Grace"
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    placeholder="Hopper"
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  value={user.primaryEmailAddress?.emailAddress ?? ""}
                  disabled
                  readOnly
                />
                <p className="text-xs text-muted-foreground">
                  Your email is your sign-in identity and can&apos;t be changed here.
                </p>
              </div>

              <Button type="submit" disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizations</CardTitle>
          <CardDescription>Where you are a member, and what you can do there.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {memberships.map((m) => (
            <div
              key={m.organization.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.organization.name}</p>
                <p className="text-xs text-muted-foreground">
                  Joined {formatDate(m.organization.createdAt)} · /{m.organization.slug}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                {m.organization.id !== activeOrg?.organization.id && (
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/${m.organization.slug}/dashboard`}>Open</Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
