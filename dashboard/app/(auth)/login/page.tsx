import Link from "next/link";
import { redirect } from "next/navigation";
import { loginAction, mfaLoginAction } from "@/app/auth-actions";
import { currentUser } from "@/lib/session";
import { LANDING_PATH, REDIRECT_PARAM, safeRedirectTo } from "@/lib/redirect-to";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { LIMITS } from "@/lib/limits";
import { googleConfig } from "@/lib/google-oauth";
import { signupMode } from "@/lib/signup-config";
import { GoogleOneTap } from "@/components/auth/google-one-tap";
import { Separator } from "@/components/ui/separator";
import { CheckboxField } from "@/components/ui/checkbox";
import { Chip } from "@/components/patterns/chip";
import { mfaStepUrl, readMfaChallenge } from "@/lib/mfa-challenge";
import { ResetPendingCallout } from "@/components/account/reset-pending-callout";
import { PasskeySecondStep, PasskeySignInButton } from "@/components/auth/passkey-sign-in";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

/**
 * Sign in. Links to the self-serve sandbox sign-up (`/signup`, 0354) only when the
 * deployment offers it (SIGNUP_ENABLED); otherwise operators join by invitation.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    reset?: string;
    mfa?: string;
    method?: string;
    help?: string;
    redirectTo?: string;
  }>;
}) {
  const { error, reset, mfa, method, help, redirectTo } = await searchParams;
  const dest = safeRedirectTo(redirectTo);

  /**
   * Already signed in — the sign-in screen has nothing to offer, so go where they
   * were headed, or home.
   *
   * `currentUser()` and not the session cookie, which is what `proxy.ts` can see:
   * the cookie only tells you one is PRESENT. Bouncing /login on a present-but-dead
   * cookie sends the visitor to a page that bounces them straight back — a loop with
   * no way out except clearing cookies by hand. This validates against the API and
   * returns null for an expired session, so a stale cookie still gets a login form.
   */
  if (await currentUser()) redirect(dest ?? LANDING_PATH);
  /*
   * The button renders only when Google sign-in is actually configured. CLAUDE.md's
   * rule, and it matters here more than most: a "Sign in with Google" that leads to a
   * Google error page is worse than no button, because the operator cannot tell whether
   * the problem is their account or ours.
   */
  const google = await googleConfig();
  const signup = await signupMode();
  const canSignUp = signup === "open";

  /*
   * The second step of a sign-in that stopped at the second factor (audit M3).
   *
   * A SEPARATE screen rather than a code field on the password form: the password has already
   * been accepted, so re-showing it invites re-typing something that was correct, and the
   * challenge lives in an HttpOnly cookie precisely so the password is not carried forward.
   * Nothing here reveals whether the account exists — the visitor already proved it does.
   */
  if (mfa) {
    const { challenge, who } = await readMfaChallenge();
    const hasPasskey = (who?.passkeyNames.length ?? 0) > 0;
    const hasApp = who?.authenticatorApp !== false;
    // A passkey, when there is one, is the default: nothing to type, and phishing-proof.
    const view: "passkey" | "totp" | "recovery" =
      method === "recovery"
        ? "recovery"
        : method === "totp" && hasApp
          ? "totp"
          : hasPasskey
            ? "passkey"
            : "totp";
    const recovery = view === "recovery";
    const stepHref = (extra: Record<string, string>) => mfaStepUrl(dest, extra);
    const viewParams: Record<string, string> = view === "passkey" ? {} : { method: view };
    // Every other way to finish, as links under the form.
    const switches = [
      view !== "passkey" && hasPasskey ? { label: "Use a passkey", params: {} } : null,
      view !== "totp" && hasApp
        ? { label: "Use your authenticator app", params: { method: "totp" } }
        : null,
      view !== "recovery" ? { label: "Use a recovery code", params: { method: "recovery" } } : null,
    ].filter((x): x is { label: string; params: Record<string, string> } => x !== null);
    const contact = who?.supportEmail ?? null;
    return (
      <div className="space-y-6">
        <div className="flex justify-center">
          <Wordmark size="lg" />
        </div>
        <Card>
          {challenge ? (
            <>
              <CardHeader className="space-y-2 text-center">
                <CardTitle className="text-xl">Complete the sign-in</CardTitle>
                {who?.email ? (
                  <div className="flex justify-center">
                    <Chip>
                      {who.email} · ✓ {who.method === "google" ? "Google" : "Password"}
                    </Chip>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4">
                {who?.resetEffectiveAt ? (
                  <ResetPendingCallout effectiveAt={who.resetEffectiveAt} />
                ) : null}
                {help ? (
                  // Support-assisted reset: there is nothing to submit here — support files it
                  // after checking a second proof, and the owner can stop it from the email.
                  <div className="space-y-3 text-sm">
                    <p className="font-semibold">Get help signing in</p>
                    <p className="text-muted-foreground">
                      If you cannot use your{" "}
                      {hasPasskey && hasApp
                        ? "passkey, authenticator app"
                        : hasPasskey
                          ? "passkey"
                          : "authenticator app"}{" "}
                      or your recovery codes, support can disable two-factor authentication. Support
                      first makes sure that the request comes from you.
                    </p>
                    <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
                      <li>
                        {contact ? (
                          <>
                            Email{" "}
                            <a href={`mailto:${contact}`} className="text-primary hover:underline">
                              {contact}
                            </a>{" "}
                            from {who?.email || "the address you sign in with"}.
                          </>
                        ) : (
                          <>
                            Ask your administrator, from{" "}
                            {who?.email || "the address you sign in with"}.
                          </>
                        )}
                      </li>
                      <li>
                        Support asks for one more proof. For example, sign in with Google or use a
                        browser that you used before.
                      </li>
                      <li>
                        Support disables two-factor authentication{" "}
                        {who?.resetWaitDays
                          ? `${who.resetWaitDays} ${who.resetWaitDays === 1 ? "day" : "days"} later`
                          : "a few days later"}
                        . We send you an email with a link that stops the reset.
                      </li>
                    </ol>
                    <Link href={stepHref(viewParams)} className="text-primary hover:underline">
                      Back
                    </Link>
                  </div>
                ) : view === "passkey" ? (
                  <PasskeySecondStep
                    passkeyNames={who?.passkeyNames ?? []}
                    redirectTo={dest ?? undefined}
                  />
                ) : (
                  <ActionForm action={mfaLoginAction} className="space-y-3">
                    {dest ? <input type="hidden" name={REDIRECT_PARAM} value={dest} /> : null}
                    <input type="hidden" name="method" value={recovery ? "recovery" : "totp"} />
                    {recovery ? (
                      <Field
                        name="code"
                        label="Enter a recovery code"
                        help="You can use each code one time only."
                      >
                        <Input
                          name="code"
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          placeholder="XXXX-XXXX-XXXX-XXXX"
                          required
                          maxLength={40}
                          autoFocus
                        />
                      </Field>
                    ) : (
                      <Field name="code" label="Enter the code from your authenticator app">
                        {/* Not type="number": that strips leading zeros, and a TOTP code
                          routinely starts with one. */}
                        <Input
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="123456"
                          required
                          maxLength={20}
                          autoFocus
                        />
                      </Field>
                    )}
                    {/* Not offered with a recovery code: that is how someone without the phone
                      gets in, and it should not also buy 30 days of not being asked. */}
                    {recovery ? null : (
                      <CheckboxField
                        name="trust_browser"
                        label="Do not ask again on this browser for 30 days"
                        hint="Select this only on your own computer."
                      />
                    )}
                    <Button type="submit" className="w-full">
                      Sign in
                    </Button>
                  </ActionForm>
                )}
                <div className="flex flex-col items-center gap-1.5 text-sm">
                  {help
                    ? null
                    : switches.map((x) => (
                        <Link
                          key={x.label}
                          href={stepHref(x.params)}
                          className="text-primary hover:underline"
                        >
                          {x.label}
                        </Link>
                      ))}
                  {help ? null : (
                    <Link
                      href={stepHref({ ...viewParams, help: "1" })}
                      className="text-muted-foreground hover:underline"
                    >
                      Get help signing in
                    </Link>
                  )}
                  <Link href="/login" className="text-muted-foreground hover:underline">
                    Not you? Start again
                  </Link>
                </div>
              </CardContent>
            </>
          ) : (
            // The challenge cookie is gone: five minutes passed, or the API refused it.
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-xl">This sign-in timed out</CardTitle>
                <p className="text-sm text-muted-foreground">
                  For your security, the second step stays open for a few minutes only. Sign in
                  again to continue.
                </p>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full">
                  <Link
                    href={dest ? `/login?${REDIRECT_PARAM}=${encodeURIComponent(dest)}` : "/login"}
                  >
                    Sign in again
                  </Link>
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/*
        One Tap, shown alongside the form rather than instead of it. It renders no markup
        of ours — the card is Google's — and it is mounted only when Google sign-in is
        configured, for the same reason the button below is: a prompt that cannot complete
        is worse than no prompt.

        Not shown when an error is already on screen: the card would cover the message
        explaining why the last attempt failed.
      */}
      {google && !error ? (
        <GoogleOneTap clientId={google.clientId} redirectTo={dest ?? undefined} />
      ) : null}
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <p className="text-sm text-muted-foreground">Welcome back</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert tone="error" title="Sign-in failed">
              {error}
            </Alert>
          ) : null}
          {reset ? (
            <Alert tone="success" title="Password updated">
              Sign in with your new password. Any other sessions were signed out.
            </Alert>
          ) : null}

          {/*
            `Field` renders the action's per-field errors against the input that caused
            them (components/form/field.tsx). A credential failure stays a toast,
            deliberately — "invalid email or password" is worded not to say which, and
            pinning it to one field would say it.
          */}
          <ActionForm action={loginAction} className="space-y-3">
            {/* The destination survives the round trip as a field, so the action
                redirects there instead of home. Already validated above. */}
            {dest ? <input type="hidden" name={REDIRECT_PARAM} value={dest} /> : null}
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
            <Field name="password" label="Password">
              <Input
                name="password"
                type="password"
                placeholder="Password"
                required
                maxLength={LIMITS.password}
                autoComplete="current-password"
              />
            </Field>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              <a href="/forgot-password" className="text-primary hover:underline">
                Forgot your password?
              </a>
            </p>
          </ActionForm>

          <PasskeySignInButton redirectTo={dest ?? undefined} />

          {google ? (
            <>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs tracking-widest text-muted-foreground uppercase">or</span>
                <Separator className="flex-1" />
              </div>
              {/*
                A plain link, not a form: `/auth/google/start` is a GET that mints the
                CSRF state cookie and redirects to Google.

                `variant="outline"` on purpose — `--solid` (the ink fill) is reserved for
                the primary action, and on this card that is signing in with a password.
                A second filled button would give two controls equal weight.

                The mark is Google's official asset, kept under its original filename so
                it stays obvious WHICH variant of their branding kit this is (web /
                neutral / round). It is a TRADEMARK: it must not be recoloured, tinted or
                monochromed to match our theme, which is why it is a flat image rather
                than an inline SVG inheriting `currentColor`. It renders identically in
                light and dark, deliberately.

                `<img>` and not `next/image`: this is a fixed 16px decorative mark on the
                login screen, so the optimiser has nothing to do — and `next/image` would
                put a route in front of an asset that is already 2.3 KB.

                Sized explicitly. `ui/button.tsx` auto-sizes SVG children (`size-4`) but
                that selector does not reach an `<img>`, so without this the raw 80×80
                would render at its natural size and blow the button apart.

                20px, not the button's default 16px for an icon. The mark is a round badge
                with its own internal padding, so at 16px the coloured G inside it reads
                smaller than the 14px text beside it and the button looked wordmark-only.
                20px inside a 36px control is Google's own ratio for their sign-in button
                and still clears the button's 8px vertical padding.
              */}
              <Button asChild variant="outline" className="w-full">
                <a
                  href={
                    dest
                      ? `/auth/google/start?${REDIRECT_PARAM}=${encodeURIComponent(dest)}`
                      : "/auth/google/start"
                  }
                >
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
            </>
          ) : null}

          {/*
            Someone without an account is told the way in: the free sign-up where the
            deployment offers it, an invitation where it does not.
          */}
          {canSignUp ? (
            <p className="text-center text-sm text-muted-foreground">
              New to Two Minute Billing?{" "}
              <Link href="/signup" className="text-primary hover:underline">
                Create a free account
              </Link>
            </p>
          ) : signup === "requests" ? (
            <p className="text-center text-sm text-muted-foreground">
              New to Two Minute Billing?{" "}
              <Link href="/signup" className="text-primary hover:underline">
                Ask for access
              </Link>
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Accounts are created by invitation. Ask an administrator to add you to an
              organization.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
