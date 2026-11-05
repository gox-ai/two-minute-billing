import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { LIMITS } from "@/lib/limits";
import { currentUser } from "@/lib/session";
import { forwardedFor } from "@/lib/forwarded-for";
import { SIGNUP_INVITE_COOKIE } from "@/lib/auth-cookies";
import { LANDING_PATH } from "@/lib/redirect-to";
import { signupInviteAction } from "../actions";
import { GATEWAYS, VOLUMES, countryOptions } from "../options";

export const dynamic = "force-dynamic";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

interface Invite {
  email: string;
  name: string;
  company: string;
  country: string | null;
  billing_volume: string | null;
  gateway: string | null;
}

async function readInvite(token: string): Promise<Invite | null> {
  try {
    const res = await fetch(`${BASE}/auth/signup/invite?token=${encodeURIComponent(token)}`, {
      headers: await forwardedFor(),
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as Invite) : null;
  } catch {
    return null;
  }
}

/** A staff-sent sign-up link (0405): the email is fixed, the answers from the request prefill. */
export default async function SignupInvitePage() {
  if (await currentUser()) redirect(LANDING_PATH);
  const token = (await cookies()).get(SIGNUP_INVITE_COOKIE)?.value;
  const invite = token ? await readInvite(token) : null;
  const brand = (
    <div className="text-center text-2xl font-bold tracking-tight">
      tm<span className="text-brand">billing</span>
    </div>
  );

  if (!invite) {
    return (
      <div className="space-y-6">
        {brand}
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">This link is not valid</CardTitle>
            <p className="text-sm text-muted-foreground">
              A sign-up link works one time only, and it expires after 7 days. Open the link in the
              email again, or ask us for a new link.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full">
              <Link href="/signup">Ask for access</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          <ActionForm action={signupInviteAction} className="space-y-3">
            <Field name="email_display" label="Work email">
              <Input name="email_display" value={invite.email} readOnly disabled />
            </Field>
            <Field name="name" label="Your name">
              <Input
                name="name"
                required
                maxLength={200}
                autoComplete="name"
                defaultValue={invite.name}
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
            <Field name="organization_name" label="Company name">
              <Input
                name="organization_name"
                required
                maxLength={200}
                autoComplete="organization"
                defaultValue={invite.company}
              />
            </Field>
            <Field name="country" label="Country">
              <Combobox
                name="country"
                options={countries}
                defaultValue={invite.country ?? undefined}
                placeholder="Select your country"
                searchPlaceholder="Search countries"
              />
            </Field>
            <Field name="billing_volume" label="How much do you bill each month?">
              <SelectField
                name="billing_volume"
                options={VOLUMES}
                defaultValue={invite.billing_volume ?? undefined}
                placeholder="Select an amount"
              />
            </Field>
            <Field name="gateway" label="Which payment gateway do you use?">
              <SelectField
                name="gateway"
                options={GATEWAYS}
                defaultValue={invite.gateway ?? undefined}
                placeholder="Select a gateway"
              />
            </Field>
            <Button type="submit" className="w-full">
              Create my account
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
