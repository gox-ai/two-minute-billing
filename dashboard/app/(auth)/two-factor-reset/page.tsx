import { cookies } from "next/headers";
import Link from "next/link";
import { cancelMfaResetAction } from "@/app/auth-actions";
import { MFA_RESET_COOKIE } from "@/lib/auth-cookies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

/**
 * Cancel a support 2FA reset, from the link in its email. Public: the owner may be locked out or
 * reading on another device. The token is in an HttpOnly cookie set by `/two-factor-reset/s/…`,
 * and nothing happens until the owner clicks — a mail scanner's prefetch cannot cancel.
 */
export default async function TwoFactorResetPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const { result } = await searchParams;
  const hasToken = !!(await cookies()).get(MFA_RESET_COOKIE)?.value;
  const view =
    result === "cancelled"
      ? "done"
      : result === "throttled" && hasToken
        ? "confirm"
        : result || !hasToken
          ? "dead"
          : "confirm";

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        {view === "done" ? (
          <CardHeader className="space-y-2 text-center">
            <CardTitle className="text-xl">Reset cancelled</CardTitle>
            <p className="text-sm text-muted-foreground">
              Your two-factor authentication stays on. Did you not ask support to disable it? Then
              change your password now.
            </p>
          </CardHeader>
        ) : view === "dead" ? (
          <CardHeader className="space-y-2 text-center">
            <CardTitle className="text-xl">This link does not operate</CardTitle>
            <p className="text-sm text-muted-foreground">
              {result === "completed"
                ? "The reset is complete. You cannot cancel it now. If you did not ask for the reset, do these steps: sign in, enable two-factor authentication again, and contact support."
                : "The link may have expired. Or the reset may be cancelled or complete. If you need help, contact support."}
            </p>
          </CardHeader>
        ) : (
          <>
            <CardHeader className="space-y-2 text-center">
              <CardTitle className="text-xl">Cancel the two-factor authentication reset?</CardTitle>
              <p className="text-sm text-muted-foreground">
                Someone asked support to disable two-factor authentication on your account. If you
                did not ask for this, cancel the reset now. Your account does not change.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {result === "throttled" ? (
                <Alert tone="warning">Wait one minute. Then try again.</Alert>
              ) : null}
              <ActionForm action={cancelMfaResetAction}>
                <Button type="submit" className="w-full">
                  Cancel the reset
                </Button>
              </ActionForm>
            </CardContent>
          </>
        )}
        <CardContent className={view === "confirm" ? "pt-0" : undefined}>
          <p className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
