import { cookies } from "next/headers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/form/action-form";
import { Wordmark } from "@/components/wordmark";
import { TEAM_ALERT_CONFIRM_COOKIE, TEAM_ALERT_DONE_COOKIE } from "@/lib/auth-cookies";
import { confirmTeamAlertsAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Confirm a team alert address (0495). Public, and shows nothing about the business or the
 * address: the token is in an HttpOnly cookie that `s/[token]` parked.
 */
export default async function ConfirmTeamAlertsPage() {
  const jar = await cookies();
  const done = jar.get(TEAM_ALERT_DONE_COOKIE)?.value === "1";
  const token = jar.get(TEAM_ALERT_CONFIRM_COOKIE)?.value;
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {done
              ? "Email address confirmed"
              : token
                ? "Confirm that you want team alerts"
                : "This link is not valid or is expired"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {done
              ? "You get team alerts at this address from now on."
              : token
                ? "When you confirm, we send team alerts to the address that got this email."
                : "Ask the person who added your address to send the confirmation email again."}
          </p>
        </CardHeader>
        {!done && token ? (
          <CardContent>
            <ActionForm action={confirmTeamAlertsAction}>
              <Button type="submit" className="w-full">
                Confirm email address
              </Button>
            </ActionForm>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
