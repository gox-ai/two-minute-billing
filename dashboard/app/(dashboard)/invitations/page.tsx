import { MailOpen } from "lucide-react";
import { requireUser, currentUserInvites } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/states";
import { fmtDateTime } from "@/lib/format";
import { orgTz } from "@/lib/org-tz-server";
import { acceptInvitationAction, declineInvitationAction } from "@/app/auth-actions";

export const metadata = { title: "Invites · Two Minute Billing" };
export const dynamic = "force-dynamic";

/**
 * Invites to other organizations that wait for the signed-in operator (0498). The invite email
 * links here. Until they accept, the inviting organization sees only the address and the role.
 */
export default async function InvitationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const { error } = await searchParams;
  const invites = await currentUserInvites();
  const tz = await orgTz();

  return (
    <>
      <PageHeader
        title="Invites"
        description="Organizations that invited you. They cannot see your account details until you accept."
      />
      {error ? (
        <Alert tone="error" title="That did not work" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <Card>
        <CardContent className={invites.length === 0 ? undefined : "divide-y p-0"}>
          {invites.length === 0 ? (
            <EmptyState
              icon={<MailOpen />}
              title="No invites"
              description="When an organization invites you, the invite shows here."
            />
          ) : (
            invites.map((i) => (
              <div
                key={i.organization.id}
                className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold">{i.organization.name}</div>
                  <div className="text-sm text-muted-foreground">
                    Role: <span className="capitalize">{i.custom_role?.name ?? i.role}</span> ·
                    Invited {fmtDateTime(i.invited_at, tz)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <form action={declineInvitationAction}>
                    <input type="hidden" name="organization" value={i.organization.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Decline
                    </Button>
                  </form>
                  <form action={acceptInvitationAction}>
                    <input type="hidden" name="organization" value={i.organization.id} />
                    <Button type="submit" size="sm">
                      Accept
                    </Button>
                  </form>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </>
  );
}
