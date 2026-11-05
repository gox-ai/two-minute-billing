import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Turnstile } from "@/components/turnstile";
import { LIMITS } from "@/lib/limits";
import { currentUser } from "@/lib/session";
import { googleConfig } from "@/lib/google-oauth";
import { signupMode } from "@/lib/signup-config";
import { GOOGLE_SIGNUP_COOKIE } from "@/lib/auth-cookies";
import { LANDING_PATH } from "@/lib/redirect-to";
import { cancelGoogleSignupAction, signupAction, signupRequestAction } from "./actions";
import { GATEWAYS, VOLUMES, countryOptions } from "./options";

export const dynamic = "force-dynamic";

/** The email in a pending Google ticket, for display only; the API checks the signature. */
function googleEmail(ticket: string | undefined): string | null {
  const body = ticket?.match(/^gsu_([A-Za-z0-9_-]+)\./)?.[1];
  if (!body) return null;
  try {
    return (
      (JSON.parse(Buffer.from(body, "base64url").toString()) as { email?: string }).email ?? null
    );
  } catch {
    return null;
  }
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; expired?: string; requested?: string }>;
}) {
  const { sent, expired, requested } = await searchParams;
  if (await currentUser()) redirect(LANDING_PATH);

  const brand = (
    <div className="text-center text-2xl font-bold tracking-tight">
      tm<span className="text-brand">billing</span>
    </div>
  );

  const mode = await signupMode();

  if (mode === "requests" && requested) {
    return (
      <div className="space-y-6">
        {brand}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">We received your request</CardTitle>
            <p className="text-sm text-muted-foreground">
              Our team reads each request. When we approve it, we send a sign-up link to your email
              address.
            </p>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === "requests") {
    const countries = await countryOptions();
    return (
      <div className="space-y-6">
        {brand}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Ask for access</CardTitle>
            <p className="text-sm text-muted-foreground">
              We open accounts one at a time. Tell us about your business. When we approve your
              request, we send a sign-up link to your email address.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionForm action={signupRequestAction} className="space-y-3">
              <Turnstile siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
              <Field name="name" label="Your name">
                <Input name="name" required maxLength={200} autoComplete="name" />
              </Field>
              <Field name="email" label="Work email">
                <Input
                  name="email"
                  type="email"
                  placeholder="email@example.com"
                  required
                  maxLength={LIMITS.email}
                  autoComplete="email"
                />
              </Field>
              <Field name="company" label="Company name">
                <Input name="company" required maxLength={200} autoComplete="organization" />
              </Field>
              <Field name="country" label="Country">
                <Combobox
                  name="country"
                  options={countries}
                  placeholder="Select your country"
                  searchPlaceholder="Search countries"
                />
              </Field>
              <Field name="billing_volume" label="How much do you bill each month?">
                <SelectField
                  name="billing_volume"
                  options={VOLUMES}
                  placeholder="Select an amount"
                />
              </Field>
              <Field name="gateway" label="Which payment gateway do you use?">
                <SelectField name="gateway" options={GATEWAYS} placeholder="Select a gateway" />
              </Field>
              <Field name="message" label="What do you want to bill? (optional)">
                <Textarea name="message" rows={3} maxLength={2000} />
              </Field>
              <Button type="submit" className="w-full">
                Send my request
              </Button>
            </ActionForm>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode !== "open") {
    return (
      <div className="space-y-6">
        {brand}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Sign-up is not available</CardTitle>
            <p className="text-sm text-muted-foreground">
              On this deployment, accounts are created by invitation. Ask an administrator to add
              you to an organization.
            </p>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="space-y-6">
        {brand}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Check your email</CardTitle>
            <p className="text-sm text-muted-foreground">
              We sent a link to confirm your email address. Open it to create your account. The link
              expires in 24 hours.
            </p>
          </CardHeader>
          <CardContent className="space-y-2 text-center text-sm text-muted-foreground">
            <p>No email after a few minutes? Look in your spam folder, or sign up again.</p>
            <Link href="/signup" className="text-primary hover:underline">
              Sign up again
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const google = await googleConfig();
  const pendingGoogle = googleEmail((await cookies()).get(GOOGLE_SIGNUP_COOKIE)?.value);
  const countries = await countryOptions();

  return (
    <div className="space-y-6">
      {brand}
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Create your free account</CardTitle>
          <p className="text-sm text-muted-foreground">
            Free while you make less than $1,000 a month. Every feature. No credit card required.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {expired ? (
            <Alert tone="warning" title="That link is not valid">
              Confirmation links work one time and expire after 24 hours. Sign up again below.
            </Alert>
          ) : null}

          {pendingGoogle ? (
            <Alert tone="info" title="Signing up with Google">
              Your account uses {pendingGoogle}. Add a few details to finish.
            </Alert>
          ) : google ? (
            <>
              <Button asChild variant="outline" className="w-full">
                <a href="/auth/google/start">
                  <img
                    src="/web_neutral_rd_na@2x.png"
                    alt=""
                    width={20}
                    height={20}
                    className="size-5 shrink-0"
                  />
                  Sign up with Google
                </a>
              </Button>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs tracking-widest text-muted-foreground uppercase">or</span>
                <Separator className="flex-1" />
              </div>
            </>
          ) : null}

          <ActionForm action={signupAction} className="space-y-3">
            <Turnstile siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
            <Field name="name" label="Your name">
              <Input name="name" required maxLength={200} autoComplete="name" />
            </Field>
            {pendingGoogle ? null : (
              <>
                <Field name="email" label="Work email">
                  <Input
                    name="email"
                    type="email"
                    placeholder="email@example.com"
                    required
                    maxLength={LIMITS.email}
                    autoComplete="email"
                  />
                </Field>
                <Field
                  name="password"
                  label="Password"
                  help={`At least ${LIMITS.passwordMin} characters, with an uppercase letter, a number and a special character.`}
                >
                  <Input
                    name="password"
                    type="password"
                    required
                    minLength={LIMITS.passwordMin}
                    maxLength={LIMITS.password}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
            <Field name="organization_name" label="Company name">
              <Input
                name="organization_name"
                required
                maxLength={200}
                autoComplete="organization"
              />
            </Field>
            <Field name="country" label="Country">
              <Combobox
                name="country"
                options={countries}
                placeholder="Select your country"
                searchPlaceholder="Search countries"
              />
            </Field>
            <Field name="billing_volume" label="How much do you bill each month?">
              <SelectField name="billing_volume" options={VOLUMES} placeholder="Select an amount" />
            </Field>
            <Field name="gateway" label="Which payment gateway do you use?">
              <SelectField name="gateway" options={GATEWAYS} placeholder="Select a gateway" />
            </Field>
            <Button type="submit" className="w-full">
              {pendingGoogle ? "Create my account" : "Email me a confirmation link"}
            </Button>
          </ActionForm>

          {pendingGoogle ? (
            <form action={cancelGoogleSignupAction} className="text-center text-sm">
              <button type="submit" className="text-muted-foreground hover:underline">
                Use a different email address
              </button>
            </form>
          ) : null}
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
