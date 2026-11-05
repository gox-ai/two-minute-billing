import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { acceptInviteAction } from "@/app/auth-actions";
import { INVITE_COOKIE } from "@/lib/auth-cookies";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { googleConfig } from "@/lib/google-oauth";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { LIMITS } from "@/lib/limits";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  // The token lives in the cookie `/invite/s/<token>` parked, never in this page's URL.
  const token = (await cookies()).get(INVITE_COOKIE)?.value;
  if (!token)
    redirect("/login?error=" + encodeURIComponent("This invite link is not valid or is expired."));

  /**
   * Setting a password is NOT mandatory (2026-09-02). `inviteUser` commits the membership
   * immediately, so `loginWithGoogle` already resolves an invited person by their
   * Google-verified address and signs them in — the backend needed nothing; this screen simply
   * never said so. Gated on `googleConfig()` for CLAUDE.md's reason: a button that leads to a
   * Google error page is worse than no button, because the invitee cannot tell whether the
   * fault is theirs.
   */
  const google = await googleConfig();

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {google ? "Complete your account" : "Choose your password"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {google
              ? "Set a password, or continue with Google. Either way, nobody who invited you can sign in as you."
              : "Only you know it. The person who invited you cannot see it."}
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
            cookie, so it is in neither the address bar nor this document.
          */}
          <ActionForm action={acceptInviteAction} className="space-y-3">
            <Field
              name="password"
              label="Password"
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
            <Field name="confirm_password" label="Confirm password">
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
              Set password and sign in
            </Button>
          </ActionForm>

          {google ? (
            <>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs tracking-widest text-muted-foreground uppercase">or</span>
                <Separator className="flex-1" />
              </div>
              {/*
                Same control as the login screen, and deliberately identical — see the long
                note there for why the mark is an <img> at 20px and why this stays
                `variant="outline"` (it is a trademark that must not be recoloured, and the
                ink fill belongs to the primary action, which on this card is setting a
                password).

                A plain link, not a form: `/auth/google/start` is a GET that mints the CSRF
                state cookie and redirects to Google. It carries no invite token and needs
                none — the address Google asserts is what resolves the invited user.
              */}
              <Button asChild variant="outline" className="w-full">
                <a href="/auth/google/start">
                  <img
                    src="/web_neutral_rd_na@2x.png"
                    alt=""
                    width={20}
                    height={20}
                    className="size-5 shrink-0"
                  />
                  Continue with Google
                </a>
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Google signs you in without a password. After that, your invite link stops working.
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
