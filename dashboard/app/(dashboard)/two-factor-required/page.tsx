import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { currentUserOrganizations, requireUser } from "@/lib/session";
import { logoutAction, switchOrganizationAction } from "@/app/auth-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * The organization requires two-factor authentication and this member's deadline has passed
 * (0329). `requireUser` sends them here from every other page; the API already refuses their
 * `/v1/*` calls, so this screen only offers the ways forward: set it up, open another
 * organization, or sign out.
 */
export default async function TwoFactorRequiredPage() {
  const me = await requireUser();
  const standing = me.organization_two_factor;
  // Not (or no longer) blocked — e.g. they just set it up in another tab.
  if (!standing?.blocked) redirect("/");
  const org = standing.organization.name;
  const others = (await currentUserOrganizations()).filter((o) => !o.current);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 pt-10">
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <ShieldAlert className="size-8 text-warning" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-xl font-semibold">{org} requires two-factor authentication</h1>
            <p className="m-0 text-sm text-muted-foreground">
              To open {org}, add a passkey or an authenticator app. This takes approximately two
              minutes.
            </p>
          </div>
          <div>
            <Button asChild>
              <Link href="/account#two-factor">Enable 2FA</Link>
            </Button>
          </div>
          {others.length > 0 ? (
            <div className="flex flex-col gap-2 border-t pt-4">
              <p className="m-0 text-sm text-muted-foreground">
                This does not apply to your other organizations. You are also in{" "}
                {others.length === 1
                  ? "1 other organization"
                  : `${others.length} other organizations`}
                .
              </p>
              <div className="flex flex-wrap gap-2">
                {others.map((o) => (
                  <form key={o.id} action={switchOrganizationAction}>
                    <input type="hidden" name="organization" value={o.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Switch to {o.name}
                    </Button>
                  </form>
                ))}
              </div>
            </div>
          ) : null}
          <form action={logoutAction} className="border-t pt-4">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
