import { cookies } from "next/headers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/form/action-form";
import { Wordmark } from "@/components/wordmark";
import { DESTINATION_CONFIRM_COOKIE, DESTINATION_DONE_COOKIE } from "@/lib/auth-cookies";
import { confirmDestinationAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Confirm an outside email address for team notifications (0533). Public, and shows nothing
 * about the organization or the address: the token is in an HttpOnly cookie `s/[token]` parked.
 */
export default async function ConfirmDestinationPage() {
  const jar = await cookies();
  const done = jar.get(DESTINATION_DONE_COOKIE)?.value === "1";
  const token = jar.get(DESTINATION_CONFIRM_COOKIE)?.value;
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            <h1>
              {done
                ? "Email address confirmed"
                : token
                  ? "Confirm that you want notifications"
                  : "This link is not valid or is expired"}
            </h1>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {done
              ? "You get billing notifications at this address from now on."
              : token
                ? "When you confirm, we send billing notifications to the address that got this email."
                : "Ask the person who added your address to send the confirmation email again."}
          </p>
        </CardHeader>
        {!done && token ? (
          <CardContent>
            <ActionForm action={confirmDestinationAction}>
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
