import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resetPasswordAction } from "@/app/auth-actions";
import { RESET_COOKIE } from "@/lib/auth-cookies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { LIMITS } from "@/lib/limits";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // The token lives in the cookie `/reset-password/s/<token>` parked, never in this
  // page's URL. No cookie means the link was never followed, or it has aged out.
  const token = (await cookies()).get(RESET_COOKIE)?.value;
  if (!token) redirect("/forgot-password?expired=1");

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Choose a new password</CardTitle>
          <p className="text-sm text-muted-foreground">
            When you set it, we sign you out on all browsers.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert tone="error" title="That did not work">
              {error}
            </Alert>
          ) : null}

          {/*
            No hidden token field. The credential is read server-side from an HttpOnly
            cookie, so it is in neither the address bar nor this document — nothing
            running on the page can reach it.
          */}
          <ActionForm action={resetPasswordAction} className="space-y-3">
            <Field
              name="password"
              label="New password"
              help={`At least ${LIMITS.passwordMin} characters, with an uppercase letter, a number and a special character.`}
            >
              <Input
                name="password"
                type="password"
                placeholder={`At least ${LIMITS.passwordMin} characters`}
                required
                minLength={LIMITS.passwordMin}
                maxLength={LIMITS.password}
                autoComplete="new-password"
              />
            </Field>
            <Field name="confirm_password" label="Confirm new password">
              <Input
                name="confirm_password"
                type="password"
                placeholder="Type it again"
                required
                minLength={LIMITS.passwordMin}
                maxLength={LIMITS.password}
                autoComplete="new-password"
              />
            </Field>
            <Button type="submit" className="w-full">
              Set new password
            </Button>
          </ActionForm>

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
