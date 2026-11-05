import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { LIMITS } from "@/lib/limits";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";
import { QrCode } from "@/components/qr-code";
import { Chip } from "@/components/patterns/chip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/components/patterns/record-page";
import { CopyButton } from "@/components/patterns/copy-button";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SummaryList,
} from "@/components/settings/settings-layout";
import { RecoveryCodesReveal } from "@/components/account/recovery-codes-reveal";
import {
  AuthenticatorAppButton,
  RegenerateCodesButton,
  TurnOffTwoFactorButton,
} from "@/components/account/two-factor-actions";
import { StepUpProvider, type StepUpProof } from "@/components/account/step-up";
import { getStepUpStatus } from "@/lib/step-up";
import {
  AddPasskeyButton,
  RemoveAuthenticatorAppButton,
  RemovePasskeyButton,
  RenamePasskeyButton,
} from "@/components/account/passkey-actions";
import { cancelMfaSetupAction, changePasswordAction, confirmMfaAction } from "@/app/auth-actions";
import {
  getMfaStatus,
  readMfaSetup,
  readNewRecoveryCodes,
  type MfaStatus,
  type PasskeySummary,
} from "@/lib/mfa";
import { ResetPendingCallout } from "@/components/account/reset-pending-callout";
import {
  describeUserAgent,
  getAvatarCapability,
  getMySessions,
  getTrustedBrowsers,
  type AccountSession,
  type TrustedBrowser,
} from "@/lib/account";
import {
  ForgetAllBrowsersButton,
  ForgetBrowserButton,
} from "@/components/account/trusted-browser-actions";
import { ProfilePhoto } from "@/components/account/profile-photo";
import { AppearanceField } from "@/components/account/appearance-field";
import { SignOutOthersButton, SignOutSessionButton } from "@/components/account/session-actions";
import { updateProfileAction } from "./actions";
import { safeRedirectTo } from "@/lib/redirect-to";

/**
 * Your own account: profile, appearance, and how you sign in (2FA, password, sessions).
 *
 * ── WHY THIS PAGE EXISTS SEPARATELY FROM /settings ──────────────────────────────
 * "Your password" lived on `/settings`, which is `requirePermission("settings:manage", "admin")` — so a manager,
 * ops or developer user could not change their own password from the dashboard at all. A
 * PERSONAL setting behind an ORGANISATION-admin gate. Guarded with `requireUser()`: every
 * signed-in person, whatever their role.
 *
 * The two-factor card is a list of METHOD rows — passkeys, then the authenticator app — plus the
 * recovery codes. Either method alone keeps 2FA on (0330).
 */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function lastUsed(iso: string | null): string {
  if (!iso) return "never used";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "last used today";
  if (days === 1) return "last used yesterday";
  if (days < 30) return `last used ${days} days ago`;
  return `last used ${day(iso)}`;
}

/** "2 passkeys and an authenticator app" — what 2FA is on with. */
function methodsPhrase(passkeys: number, app: boolean, own = false): string {
  const parts = [
    passkeys === 1
      ? `${own ? "your " : "a "}passkey`
      : passkeys > 1
        ? `${own ? "your " : ""}${passkeys} passkeys`
        : null,
    app ? `${own ? "your" : "an"} authenticator app` : null,
  ].filter(Boolean);
  return parts.join(" and ");
}

/** What keeps 2FA on once this passkey is gone: "your other passkey and your authenticator app". */
function remainingAfter(passkeys: number, app: boolean): string {
  const others = passkeys - 1;
  const parts = [
    others === 1 ? "your other passkey" : others > 1 ? `your ${others} other passkeys` : null,
    app ? "your authenticator app" : null,
  ].filter(Boolean);
  return parts.join(" and ");
}

/** One passkey: its name, where it lives, when it was added and last used. */
function PasskeyRow({
  p,
  mfa,
  lockedLast,
}: {
  p: PasskeySummary;
  mfa: MfaStatus;
  lockedLast: boolean;
}) {
  const isLast = mfa.passkeys.length === 1 && !mfa.authenticatorApp;
  return (
    <SettingRow
      label={p.name}
      help={[
        p.backedUp ? "Synced passkey" : "Saved on one device",
        `added ${day(p.createdAt)}`,
        lastUsed(p.lastUsedAt),
      ].join(" · ")}
      placement="end"
      control={
        <span className="inline-flex items-center gap-1">
          <RenamePasskeyButton id={p.id} name={p.name} />
          {/* The only method, while an organization requires 2FA: the API would refuse it, and
              the card's footnote says why. */}
          {isLast && lockedLast ? null : (
            <RemovePasskeyButton
              id={p.id}
              name={p.name}
              isLast={isLast}
              remaining={remainingAfter(mfa.passkeys.length, mfa.authenticatorApp)}
            />
          )}
        </span>
      }
    />
  );
}

/** The recovery-codes row: how many are left, and the warning the count deserves. */
function RecoveryCodesRow({ mfa }: { mfa: MfaStatus }) {
  const left = mfa.recoveryCodesLeft;
  let state: ReactNode;
  let help: string;
  if (!mfa.recoveryCodesSaved) {
    state = <Chip tone="red">Not saved</Chip>;
    help =
      "You did not save your recovery codes. Make new codes now, so that you do not lose access.";
  } else if (left === 0) {
    state = <Chip tone="red">None left</Chip>;
    help = "Make new codes, so that you do not lose access.";
  } else if (left <= 3) {
    state = <Chip tone="tan">{left} left</Chip>;
    help = "Make new codes before you use all of them.";
  } else {
    state = null;
    help = `${left} of 10 left · use each code one time if you cannot use your ${
      mfa.passkeys.length > 0 && mfa.authenticatorApp
        ? "passkey or app"
        : mfa.passkeys.length > 0
          ? "passkey"
          : "app"
    }.`;
  }
  return (
    <SettingRow
      label={<span className="inline-flex items-center gap-2">Recovery codes {state}</span>}
      help={help}
      placement="end"
      control={
        <RegenerateCodesButton label={mfa.recoveryCodesSaved ? "Make new codes" : "Make codes"} />
      }
    />
  );
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 5) return "Active now";
  if (mins < 60) return `Last active ${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "Last active an hour ago" : `Last active ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Last active yesterday" : `Last active ${days} days ago`;
}

const METHOD: Record<string, string> = {
  password: "a password",
  google: "Google",
  passkey: "a passkey",
  "password+trusted_browser": "a password on a trusted browser",
  "google+trusted_browser": "Google on a trusted browser",
};

/** One browser that skips the sign-in code. */
function TrustedBrowserRow({ b }: { b: TrustedBrowser }) {
  const device = describeUserAgent(b.user_agent);
  const facts = [
    b.last_used_at ? `Last used ${day(b.last_used_at)}` : `Trusted ${day(b.created_at)}`,
    `until ${day(b.expires_at)}`,
    b.ip,
  ].filter(Boolean);
  return (
    <SettingRow
      label={
        <span className="inline-flex items-center gap-2">
          {device} {b.current ? <Chip tone="green">This browser</Chip> : null}
        </span>
      }
      help={facts.join(" · ")}
      placement="end"
      control={<ForgetBrowserButton id={b.id} current={b.current} label={device} />}
    />
  );
}

/** "8 Oct 2026" for a YYYY-MM-DD day, without a timezone shift. */
const dayOnly = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

/** One browser: what it is, when it was last used, where and how it signed in. */
function SessionRow({ s, multiOrg }: { s: AccountSession; multiOrg: boolean }) {
  const device = describeUserAgent(s.user_agent);
  const facts = [
    s.current ? "Active now" : ago(s.last_active_at),
    `Signed in ${day(s.created_at)}${s.auth_method && METHOD[s.auth_method] ? ` with ${METHOD[s.auth_method]}` : ""}`,
    s.ip,
    multiOrg ? s.organization : null,
  ].filter(Boolean);
  return (
    <SettingRow
      label={
        <span className="inline-flex items-center gap-2">
          {device} {s.current ? <Chip tone="green">This browser</Chip> : null}
        </span>
      }
      help={facts.join(" · ")}
      placement="end"
      control={s.current ? undefined : <SignOutSessionButton id={s.id} label={device} />}
    />
  );
}

/** A group heading between cards — the page has two scopes, you and how you sign in. */
function SectionHeading({ id, title, sub }: { id: string; title: string; sub: string }) {
  return (
    <div id={id} className="flex scroll-mt-4 flex-col gap-0.5 pt-2">
      <h2 className="m-0 text-lg font-semibold">{title}</h2>
      <p className="m-0 text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    enabled?: string;
    changed?: string;
    setup_expired?: string;
    recovery_used?: string;
    next?: string;
  }>;
}) {
  const me = await requireUser();
  const sp = await searchParams;
  const [mfa, setup, newCodes, sessions, avatar, trusted, stepUp] = await Promise.all([
    getMfaStatus(),
    readMfaSetup(),
    readNewRecoveryCodes(),
    getMySessions(),
    getAvatarCapability(),
    getTrustedBrowsers(),
    getStepUpStatus(),
  ]);
  // What the step-up dialog asks for: the server's method, narrowed by what this person has.
  const stepUpProof: StepUpProof =
    stepUp?.method === "totp" || mfa?.confirmed
      ? mfa && !mfa.authenticatorApp
        ? "recovery"
        : "code"
      : me.has_password === false
        ? "google"
        : "password";
  // The current organization's requirement (0329). It decides whether "Turn off" is offered and
  // whether this card tells them they owe a setup.
  const orgTfa = me.organization_two_factor;
  const orgRequires = !!orgTfa?.required;
  const others = sessions?.filter((x) => !x.current).length ?? 0;
  const multiOrg = new Set(sessions?.map((x) => x.organization)).size > 1;
  const next = safeRedirectTo(sp.next);

  // Card summary, read off the real enrolment record — never a placeholder.
  const mfaMeta = !mfa ? undefined : mfa.confirmed ? (
    <span className="inline-flex items-center gap-2">
      <Chip tone="green">On</Chip>
      {mfa.enabledAt
        ? `Since ${day(mfa.enabledAt)} · ${methodsPhrase(mfa.passkeys.length, mfa.authenticatorApp)}`
        : null}
    </span>
  ) : (
    <span className="inline-flex items-center gap-2">
      <Chip>Off</Chip>
      {setup ? "Setup started" : "Recommended"}
    </span>
  );

  return (
    <SettingsPage
      title="Your account"
      description="Your profile, the appearance of the dashboard, and how you sign in."
      crumbs={[]}
    >
      {sp.error ? (
        <Alert tone="error" title="The action did not complete">
          {sp.error}
        </Alert>
      ) : null}
      {sp.recovery_used !== undefined ? (
        <Alert tone="warning" title="You used a recovery code">
          You have {Number(sp.recovery_used) || 0} codes left. Make new codes, or examine your
          authenticator app. Then you can sign in the next time.
          {next ? (
            <>
              {" "}
              <Link href={next}>Later</Link>
            </>
          ) : null}
        </Alert>
      ) : null}
      {sp.enabled && !newCodes ? (
        <Alert tone="success" title="Two-factor authentication is on">
          The next sign-in asks you for a code.
        </Alert>
      ) : null}
      {sp.changed ? (
        <Alert tone="success" title="Authenticator app changed">
          Codes from your old app do not operate now.
        </Alert>
      ) : null}

      <SettingsColumns
        summary={
          <>
            <div className="flex items-center gap-3 border-b px-5 py-4">
              <Avatar className="size-10">
                {me.avatar_url ? <AvatarImage src={me.avatar_url} alt="" /> : null}
                <AvatarFallback>
                  {me.name ? initials(me.name) : (me.email[0] ?? "?").toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{me.name || me.email}</div>
                {me.name ? (
                  <div className="truncate text-xs text-muted-foreground">{me.email}</div>
                ) : null}
              </div>
            </div>
            <SummaryList
              items={[
                {
                  label: "Two-factor authentication",
                  value: mfa ? (mfa.confirmed ? "On" : "Off") : "Unknown",
                },
                sessions
                  ? {
                      label: "Signed in on",
                      value:
                        sessions.length === 1 ? "This browser only" : `${sessions.length} browsers`,
                    }
                  : null,
              ]}
            />
            <nav
              aria-label="On this page"
              className="flex flex-col gap-1 border-t px-5 py-3 text-sm"
            >
              <Link href="#profile" className="text-primary hover:underline">
                Profile
              </Link>
              <Link href="#appearance" className="text-primary hover:underline">
                Appearance
              </Link>
              <Link href="#two-factor" className="text-primary hover:underline">
                Two-factor authentication
              </Link>
              <Link href="#password" className="text-primary hover:underline">
                Password
              </Link>
              <Link href="#sessions" className="text-primary hover:underline">
                Active sessions
              </Link>
              {mfa?.confirmed ? (
                <Link href="#trusted-browsers" className="text-primary hover:underline">
                  Trusted browsers
                </Link>
              ) : null}
            </nav>
          </>
        }
      >
        <SettingsCard
          id="profile"
          title="Profile"
          meta="Your name and photo. Your team sees them."
          padded
        >
          <div className="flex flex-col gap-5">
            <ProfilePhoto
              avatarUrl={me.avatar_url ?? null}
              avatarSource={me.avatar_source ?? null}
              name={me.name ?? null}
              email={me.email}
              uploadEnabled={avatar.uploadEnabled}
              accepts={avatar.accepts}
            />
            <ActionForm action={updateProfileAction} className="flex max-w-md flex-col gap-4">
              <Field name="name" label="Full name">
                <Input
                  name="name"
                  defaultValue={me.name ?? ""}
                  maxLength={LIMITS.name}
                  autoComplete="name"
                  placeholder="Your name"
                />
              </Field>
              {/* The address is the sign-in identity, so it is shown and never edited here. */}
              <Field name="email" label="Email address">
                <Input name="email" value={me.email} readOnly disabled />
              </Field>
              <div>
                <Button type="submit">Save</Button>
              </div>
            </ActionForm>
          </div>
        </SettingsCard>

        <SettingsCard
          id="appearance"
          title="Appearance"
          meta="The appearance of the dashboard. Your account keeps this setting, not this browser."
          padded
        >
          <AppearanceField saved={me.theme ?? null} />
        </SettingsCard>

        <SectionHeading
          id="security"
          title="Security"
          sub="How you sign in, and the browsers where you are signed in."
        />

        <StepUpProvider proof={stepUpProof} windowMinutes={stepUp?.windowMinutes ?? 15}>
          <SettingsCard
            id="two-factor"
            title="Two-factor authentication"
            meta={mfaMeta}
            actions={
              mfa?.confirmed && !setup && !newCodes && !orgRequires ? (
                <TurnOffTwoFactorButton
                  methods={methodsPhrase(mfa.passkeys.length, mfa.authenticatorApp, true)}
                />
              ) : undefined
            }
            padded={!!(newCodes || setup || !mfa)}
          >
            {!mfa ? (
              <Alert tone="error" title="We could not show your two-factor settings">
                Check your connection. Then try again. <Link href="/account">Try again</Link>
              </Alert>
            ) : newCodes ? (
              // Shown first and alone: until they are saved, nothing else on this card matters.
              <RecoveryCodesReveal codes={newCodes} email={me.email} />
            ) : setup ? (
              <div className="space-y-4">
                {sp.setup_expired ? (
                  <Alert tone="info" title="This setup expired">
                    We made a new QR code. Scan the new QR code. Then enter the new code.
                  </Alert>
                ) : null}
                <p className="m-0 text-sm font-semibold">
                  {setup.replacing ? "Change the authenticator app" : "Add an authenticator app"}
                </p>
                {setup.replacing ? null : (
                  <p className="m-0 text-xs text-muted-foreground">
                    Step 1 of 2 · Step 2: save the recovery codes
                  </p>
                )}
                <p className="m-0 text-sm text-muted-foreground">
                  Scan this QR code, or enter the setup key.
                </p>
                <div className="flex flex-wrap items-start gap-4">
                  <QrCode value={setup.otpauthUri} alt="Scan this with your authenticator app" />
                  {/* The key stays legible: a QR is unusable on the device the page is open on. */}
                  <div className="min-w-0 flex-1 rounded-md bg-muted/50 p-3">
                    <div className="text-xs tracking-widest text-muted-foreground uppercase">
                      Setup key
                    </div>
                    <div className="mt-1 flex items-start gap-2">
                      <span className="font-mono text-sm break-all tabular-nums">
                        {setup.secret}
                      </span>
                      <CopyButton value={setup.secret} className="mt-0.5" />
                    </div>
                  </div>
                </div>
                <ActionForm action={confirmMfaAction} className="max-w-sm space-y-3">
                  <Field name="code" label="Enter the 6-digit code from the app">
                    {/* Not type="number": that strips a leading zero, and TOTP codes have them. */}
                    <Input
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      required
                      maxLength={20}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button type="submit">{setup.replacing ? "Change app" : "Continue"}</Button>
                  </div>
                </ActionForm>
                <form action={cancelMfaSetupAction}>
                  <Button type="submit" variant="ghost" size="sm">
                    Cancel
                  </Button>
                </form>
              </div>
            ) : (
              <>
                {mfa.resetEffectiveAt ? (
                  <div className="px-5 pt-4">
                    <ResetPendingCallout effectiveAt={mfa.resetEffectiveAt} />
                  </div>
                ) : null}
                {orgTfa && orgRequires && !mfa.confirmed ? (
                  <div className="px-5 pt-4">
                    <Alert
                      tone={orgTfa.blocked ? "error" : "warning"}
                      title={`${orgTfa.organization.name} requires two-factor authentication`}
                    >
                      {orgTfa.blocked
                        ? `Enable it to open ${orgTfa.organization.name} again. This takes approximately two minutes.`
                        : `Enable it${orgTfa.deadline_day ? ` by ${dayOnly(orgTfa.deadline_day)}` : ""} to keep access to ${orgTfa.organization.name}.`}
                    </Alert>
                  </div>
                ) : null}
                <div className="px-5 py-4">
                  <p className="m-0 text-sm text-muted-foreground">
                    The sign-in asks for a second step. Then a stolen password or inbox is not
                    sufficient to get access.
                    {mfa.confirmed ? null : " To enable it, add a passkey or an authenticator app."}
                  </p>
                </div>
                {mfa.passkeys.length === 0 ? (
                  <SettingRow
                    label="Passkey"
                    help="Sign in with your fingerprint, face or screen lock"
                    placement="end"
                    control={<AddPasskeyButton variant={mfa.confirmed ? "outline" : "default"} />}
                  />
                ) : (
                  <>
                    {mfa.passkeys.map((p) => (
                      <PasskeyRow key={p.id} p={p} mfa={mfa} lockedLast={orgRequires} />
                    ))}
                    <div className="flex justify-end border-t px-5 py-3">
                      <AddPasskeyButton label="Add a passkey" />
                    </div>
                  </>
                )}
                <SettingRow
                  label="Authenticator app"
                  help={
                    mfa.authenticatorApp
                      ? [
                          `Added ${mfa.authenticatorAppAddedAt ? day(mfa.authenticatorAppAddedAt) : ""}`,
                          // "Last used" is the second factor's, shared with passkeys — only
                          // unambiguous when the app is the only method.
                          mfa.passkeys.length === 0 ? lastUsed(mfa.lastUsedAt) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Get 6-digit codes from an app on your phone"
                  }
                  placement="end"
                  control={
                    <span className="inline-flex items-center gap-1">
                      <AuthenticatorAppButton
                        label={mfa.authenticatorApp ? "Change app" : "Add"}
                        variant={mfa.authenticatorApp || mfa.confirmed ? "outline" : "default"}
                      />
                      {/* Alone, removing the app IS turning 2FA off — that is the card's button. */}
                      {mfa.authenticatorApp && mfa.passkeys.length > 0 ? (
                        <RemoveAuthenticatorAppButton
                          remaining={methodsPhrase(mfa.passkeys.length, false, true)}
                        />
                      ) : null}
                    </span>
                  }
                />
                {mfa.confirmed ? <RecoveryCodesRow mfa={mfa} /> : null}
                {mfa.confirmed && orgTfa && orgRequires ? (
                  // Replaces "Turn off": the API refuses it while the organization requires 2FA.
                  <div className="border-t px-5 py-3 text-sm text-muted-foreground">
                    {orgTfa.organization.name} requires 2FA. You cannot disable it.
                  </div>
                ) : null}
              </>
            )}
          </SettingsCard>
        </StepUpProvider>

        {/*
          `=== false` rather than `!me.has_password`: the flag is optional on `SessionUser`, and
          an absent value (an older /auth/me payload) must fall back to ASKING. Getting that
          backwards would drop the check for everyone.
        */}
        <SettingsCard
          id="password"
          title="Password"
          meta={me.has_password === false ? "Not set. You sign in with Google." : undefined}
          padded
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {me.has_password === false
                ? "You sign in with Google and have no password yet. A password gives you a second way to sign in. Google sign-in continues to work."
                : "Changing your password signs out your other sessions. This one stays."}
            </p>
            <ActionForm action={changePasswordAction} className="max-w-sm space-y-3">
              {me.has_password === false ? null : (
                <Field name="current_password" label="Current password">
                  <Input
                    name="current_password"
                    type="password"
                    required
                    maxLength={LIMITS.password}
                    autoComplete="current-password"
                  />
                </Field>
              )}
              <Field
                name="new_password"
                label="New password"
                help={`At least ${LIMITS.passwordMin} characters, with an uppercase letter, a number and a special character.`}
              >
                <Input
                  name="new_password"
                  type="password"
                  required
                  maxLength={LIMITS.password}
                  autoComplete="new-password"
                />
              </Field>
              <Button type="submit">
                {me.has_password === false ? "Set password" : "Change password"}
              </Button>
            </ActionForm>
          </div>
        </SettingsCard>

        <SettingsCard
          id="sessions"
          title="Active sessions"
          meta="The browsers that are signed in to your account now."
          actions={others > 0 ? <SignOutOthersButton /> : undefined}
          padded={!sessions}
        >
          {sessions ? (
            sessions.map((x) => <SessionRow key={x.id} s={x} multiOrg={multiOrg} />)
          ) : (
            <Alert tone="error" title="We could not show your sessions">
              Check your connection. Then try again.
            </Alert>
          )}
        </SettingsCard>

        {/* Only when 2FA is on: without it, nothing asks for a code, so there is nothing to skip. */}
        {mfa?.confirmed ? (
          <SettingsCard
            id="trusted-browsers"
            title="Trusted browsers"
            meta="For 30 days, these browsers skip the code when you sign in. When you change your password or sign out other browsers, we forget all trusted browsers."
            actions={trusted && trusted.length > 0 ? <ForgetAllBrowsersButton /> : undefined}
            padded={!trusted || trusted.length === 0}
          >
            {!trusted ? (
              <Alert tone="error" title="We could not show your trusted browsers">
                Check your connection. Then try again.
              </Alert>
            ) : trusted.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                None. To add a trusted browser, select &ldquo;Do not ask again on this
                browser&rdquo; at the second step of the sign-in.
              </p>
            ) : (
              trusted.map((b) => <TrustedBrowserRow key={b.id} b={b} />)
            )}
          </SettingsCard>
        ) : null}
      </SettingsColumns>
    </SettingsPage>
  );
}
