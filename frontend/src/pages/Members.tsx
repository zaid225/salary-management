import * as React from "react";
import { useInvitations, useInviteMember, useMembers, useRemoveMember, useRevokeInvitation, useChangeMemberRole } from "@/hooks/queries";
import { formatDate } from "@/lib/utils";
import type { Role } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/avatar";
import { ErrorState } from "@/components/error-state";

export function MembersPage() {
  const members = useMembers();
  const invitations = useInvitations();
  const invite = useInviteMember();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const revoke = useRevokeInvitation();

  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");

  return (
    <div className="space-y-6">
      <PageHeader title="Members" description="Who can see and change this organization's data." />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite someone</CardTitle>
          <CardDescription>
            They&apos;ll get an email with a link. Re-inviting the same address re-shares the existing link
            rather than sending a second one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await invite.mutateAsync({ email, role });
              setEmail("");
            }}
          >
            <Input
              type="email"
              required
              placeholder="colleague@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="max-w-xs"
            />
            <select
              className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? "Sending…" : "Send invite"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent>
          {members.isError ? (
            <ErrorState onRetry={() => void members.refetch()} />
          ) : members.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.members.map((m) => (
                  <TableRow key={m.membership.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar
                          name={m.user?.name ?? m.user?.email ?? "?"}
                          src={m.user?.avatarUrl}
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {m.user?.name ?? m.user?.email ?? m.membership.clerkUserId}
                          </p>
                          {m.user?.email && (
                            <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <select
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                        value={m.membership.role}
                        onChange={(e) =>
                          changeRole.mutate({
                            membershipId: m.membership.id,
                            role: e.target.value as Role,
                          })
                        }
                      >
                        <option value="viewer">viewer</option>
                        <option value="admin">admin</option>
                      </select>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(m.membership.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
                            <AlertDialogDescription>
                              They lose access to this organization immediately. An organization must always
                              keep at least one admin, so removing the last one is refused.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeMember.mutate(m.membership.id)}>
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {invitations.isError ? (
            <ErrorState onRetry={() => void invitations.refetch()} />
          ) : invitations.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : invitations.data.invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.data.invitations.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inv.role}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(inv.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            Revoke
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The link sent to {inv.email} will stop working immediately.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => revoke.mutate(inv.id)}>Revoke</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
