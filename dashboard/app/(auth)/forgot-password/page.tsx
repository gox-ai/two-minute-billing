import { forgotPasswordAction } from "@/app/auth-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";
import { Turnstile } from "@/components/turnstile";
import { Field } from "@/components/form/field";
import { LIMITS } from "@/lib/limits";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; expired?: string }>;
}) {
  const { sent, error, expired } = await searchParams;
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <p className="text-sm text-muted-foreground">
            We send you an email with a link to choose a new one.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert tone="error" title="That did not work">
              {error}
            </Alert>
          ) : null}
          {expired ? (
            <Alert tone="warning" title="That link has expired">
              Reset links are valid for a short time and work once. Ask for a new one below.
            </Alert>
          ) : null}

          {sent ? (
            /*
             * Deliberately says "if there is an account", not "we sent it".
             *
             * The API answers a uniform 200 whether or not the address is one we hold —
             * a "no such account" reply is the easiest account-enumeration oracle there
             * is to build by accident (SR-2026-010). A confirmation here that claimed
             * mail had definitely been sent would leak the same fact through the UI that
             * the API was careful not to leak through its status code.
             */
            <Alert tone="success" title="Check your inbox">
              If there is a tmbilling account for that address, we sent a reset link to it. The link
              works once and expires after a short time.
            </Alert>
          ) : (
            <ActionForm action={forgotPasswordAction} className="space-y-3">
              {/* Renders nothing when no site key is configured, so there is never a
                  challenge with no server-side check behind it — nor a check with no
                  challenge in front of it. Same rule as the Google button. */}
              <Turnstile siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
              <Field name="email" label="Email">
                <Input
                  name="email"
                  type="email"
                  placeholder="email@example.com"
                  required
                  maxLength={LIMITS.email}
                  autoComplete="email"
                />
              </Field>
              <Button type="submit" className="w-full">
                Email me a reset link
              </Button>
            </ActionForm>
          )}

          <p className="text-center text-sm text-muted-foreground">
            <a href="/login" className="text-primary hover:underline">
              Back to sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
