import { getMe, listBusinesses } from "@/lib/api";
import { getCountries } from "@/lib/api/geo";
import { AddressFields } from "@/components/customers/address-fields";
import { updateOrgAction } from "@/app/actions";
import { requirePermission } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LIMITS } from "@/lib/limits";
import { Chip, IdChip } from "@/components/patterns/chip";
import {
  SettingsCard,
  SettingsLinkRow,
  SettingsPage as SettingsShell,
} from "@/components/settings/settings-layout";
import { SettingRow } from "@/components/patterns/settings-page";
import { TimezoneSelect } from "@/components/form/timezone-select";
import { ErrorState, EmptyState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SelectField } from "@/components/ui/select-field";
import { brandImageSupport } from "@/lib/api/brand-images";
import { OrgLogoField } from "@/components/brand/org-logo-field";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { SettingRow as SecurityRow } from "@/components/settings/settings-layout";
import { RequireTwoFactorSwitch } from "@/components/settings/require-two-factor-switch";
import { getOrganizationSecurity } from "@/lib/org-security";
import { CheckboxField } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/form/submit-button";
import { saveSessionPolicyAction } from "./security-actions";
import { accountBillingEnabled } from "@/lib/account-billing";

export const dynamic = "force-dynamic";

// Org-level settings hub — the same card shape as the per-business hub at
// /businesses/[biz]/settings and Billing rules.
//
// Every row's `value` is read off a real field (Rule 0); a row with nothing meaningful
// to summarize passes none rather than a placeholder.
//
// The organization card is NOT a set of link rows: renaming the org is a one-field
// edit with no detail page to send anyone to, and the org id has no destination at
// all. So that card holds `SettingRow`s (archetype 6b — question on the left,
// the answer on the right) instead. Each row saves in place and toasts the result.
export default async function SettingsPage() {
  const me = await requirePermission("settings:manage", "admin");

  let org: Awaited<ReturnType<typeof getMe>>;
  let businesses: Awaited<ReturnType<typeof listBusinesses>>;
  let countries: Awaited<ReturnType<typeof getCountries>>;
  let upload: Awaited<ReturnType<typeof brandImageSupport>>;
  let security: Awaited<ReturnType<typeof getOrganizationSecurity>>;
  try {
    // `brandImageSupport` and `getOrganizationSecurity` never throw: each answers "unknown".
    [org, businesses, countries, upload, security] = await Promise.all([
      getMe(),
      listBusinesses(),
      getCountries(),
      brandImageSupport(),
      getOrganizationSecurity(),
    ]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not connect to the API"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  // A test twin is its live business's test mode, configured from inside that business.
  const listed = businesses.data.filter((b) => b.livemode === "live" || !b.live_business_id);
  const count = listed.length;

  // Real options only (Rule 0): the currencies the organization actually bills in, not a
  // hand-typed world list. Union of every business's default plus its additional
  // currencies, deduped and sorted.
  const currencyOptions = Array.from(
    new Set(
      businesses.data.flatMap((b) => [
        ...(b.default_currency ? [b.default_currency.toUpperCase()] : []),
        ...(b.currencies ?? []).map((c) => c.toUpperCase()),
      ]),
    ),
  ).sort();

  return (
    <SettingsShell
      title="Settings"
      description="Organization-wide settings. Catalog, currency, gateways and email live on each business."
      crumbs={[]}
    >
      <SettingsCard
        title="Organization"
        meta="The account that owns every business, and the API keys, webhooks and team they share"
      >
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What is this organization called?"
            help="Shown in the organization switcher and anywhere the account is named as a whole."
          >
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Input
                name="name"
                defaultValue={org.name}
                aria-label="Organization name"
                required
                maxLength={LIMITS.name}
                className="w-72"
              />
              <Button type="submit">Save</Button>
            </div>
          </SettingRow>
        </ActionForm>
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What logo should the sidebar show?"
            help={
              upload.uploadEnabled
                ? "A square image, shown at the top of the sidebar on organization-wide screens. Upload a PNG, JPEG, GIF or WebP up to 5 MB, or paste an https URL. Without one the sidebar shows the product mark."
                : "A square image, shown at the top of the sidebar on organization-wide screens. Paste an https URL to a PNG, JPEG, GIF or WebP. Without one the sidebar shows the product mark."
            }
          >
            <OrgLogoField iconUrl={org.icon_url ?? null} upload={upload} />
          </SettingRow>
        </ActionForm>
        {/* One form PER ROW, not one for the card: the API patches only the fields a
            request carries, so a row the operator did not open posts nothing and its
            value is left alone. Same shape as the name row above — question left,
            answer + Save right. */}
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What time zone should organization-wide screens use?"
            help="Applies to System, Audit Log and Developers. These screens show data from all businesses and have no business time zone of their own. Each business keeps its own time zone for billing days and invoice dates. This setting does not change it."
          >
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <TimezoneSelect
                name="timezone"
                // The org's ACTUAL stored value. Empty renders the picker's
                // placeholder plus the note below, rather than preselecting a UTC
                // that was never chosen.
                defaultValue={org.timezone}
                className="w-72"
                description="Sets how organization-wide screens show a timestamp. These screens are System, Audit Log and Developers. It does not move a billing day. Subscription terms and invoice dates use each business's own time zone."
              />
              <Button type="submit">Save</Button>
            </div>
            {/* Says what "unset" resolves to, so the empty picker is not a mystery.
                Rendered only when it IS unset — a note repeating the value already
                shown in the control is noise. */}
            {org.timezone ? null : (
              <p className="mt-1 text-xs text-muted-foreground sm:text-right">
                Not set. These screens show UTC.
              </p>
            )}
          </SettingRow>
        </ActionForm>
        {/* ── The registered entity ────────────────────────────────────────────
            Only meaningful once a business is set to issue under the organization,
            and the row below says so rather than presenting three fields with no
            stated effect. The engine falls back to the business when this is empty,
            so a half-filled entity can never blank a seller block. */}
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What is the registered legal entity?"
            help="We print this as the seller on invoices from each business that issues under the organization. If you leave it empty, those invoices use the business's own name. A tax document needs this entity name. It is often longer than the account name above."
          >
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Input
                name="legal_name"
                defaultValue={org.legal_name ?? ""}
                aria-label="Registered legal name"
                placeholder={org.name}
                maxLength={LIMITS.name}
                className="w-72"
              />
              <Button type="submit">Save</Button>
            </div>
          </SettingRow>
        </ActionForm>
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What is the entity's tax registration number?"
            help="GSTIN in India, VAT ID in other countries. A buyer claims input tax credit against the number on the invoice. When the entity is the seller, the number must be the entity's own."
          >
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Input
                name="tax_registration_number"
                defaultValue={org.tax_registration_number ?? ""}
                aria-label="Entity tax registration number"
                maxLength={64}
                className="w-72"
              />
              <Button type="submit">Save</Button>
            </div>
          </SettingRow>
        </ActionForm>
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="What is the entity's registered address?"
            help="The seller address on invoices issued under the organization. It uses the same fields as a business address, so one invoice layout shows both."
          >
            <div className="flex flex-col gap-3">
              {/* Marks THIS row as the submitter. Every row posts its own form, so
                  without it the other rows would send an empty address and wipe
                  what is stored here. */}
              <input type="hidden" name="addr_fields" value="1" />
              <AddressFields
                countries={countries}
                value={org.address ?? null}
                prefix="addr_"
                includeContact={false}
                requireCore={false}
              />
              <div className="flex sm:justify-end">
                <Button type="submit">Save address</Button>
              </div>
            </div>
          </SettingRow>
        </ActionForm>
        <SettingRow
          question="Organization ID"
          help="The tenant for every API request, webhook and ledger entry. You cannot change it."
        >
          <IdChip id={org.id} />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Reporting"
        meta="Analytics converts amounts into one currency to show one total. Billed and stored amounts do not change."
      >
        <ActionForm action={updateOrgAction}>
          <SettingRow
            question="Which currency should analytics report in?"
            help={
              currencyOptions.length > 1
                ? "Your businesses bill in more than one currency. Analytics uses the rates on file to convert each currency into this one, then adds them. If a currency has no rate, we name it and do not drop it. Until you select a currency, we refuse a cross-currency total. A currency set on a request still takes priority."
                : "Analytics reports in this currency and converts amounts billed in other currencies. Billed and stored amounts do not change."
            }
          >
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <SelectField
                name="base_currency"
                defaultValue={org.base_currency ?? ""}
                ariaLabel="Reporting currency"
                className="w-72"
                placeholder="Not set. Ask me each time"
                options={[
                  { value: "", label: "Not set. Ask me each time" },
                  ...currencyOptions.map((c) => ({ value: c, label: c })),
                ]}
              />
              <Button type="submit">Save</Button>
            </div>
          </SettingRow>
        </ActionForm>
      </SettingsCard>

      <SettingsCard title="AI usage" meta="Prices for AI models, for all businesses">
        <SettingsLinkRow
          title="Model prices"
          description="The list price of each AI model and token type. Set your own cost for a model."
          href="/settings/model-prices"
        />
      </SettingsCard>

      <SettingsCard
        title="Businesses"
        meta={
          count > 0
            ? `${count} ${count === 1 ? "business" : "businesses"}, each with its own catalog, currency, gateways and customers`
            : "Each keeps its own catalog, currency, gateways and customers"
        }
      >
        {count === 0 ? (
          <EmptyState
            title="No businesses yet"
            description="A business holds a catalog, a currency and its own customers. Create one to start configuring it."
          />
        ) : (
          listed.map((b) => (
            <SettingsLinkRow
              key={b.id}
              title={b.name}
              description={<span className="font-mono text-xs">{b.id}</span>}
              badge={b.livemode === "test" ? <Chip tone="tan">TEST</Chip> : undefined}
              value={b.default_currency ?? "No default currency"}
              href={`/businesses/${b.id}/settings`}
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard
        id="security"
        title="Security"
        meta="How all members of this organization sign in"
      >
        {security ? (
          <>
            <OrgTwoFactorRows security={security} orgName={org.name} tz={org.timezone ?? null} />
            <SessionPolicyRows security={security} />
          </>
        ) : (
          <div className="px-5 py-4">
            <Alert tone="error" title="We could not show the security settings">
              Check your connection. Then try again.
            </Alert>
          </div>
        )}
      </SettingsCard>

      {/* "Your password" moved to /account (audit M3). It is a PERSONAL setting and this
          page is requirePermission("settings:manage", "admin"), so a manager, ops or developer user could not
          reach their own password here — the same defect as a control that does nothing, one
          layer up. /account is requireUser(), and two-factor enrolment lives beside it. This
          row only POINTS there; it does not bring the form back onto an admin-gated page. */}
      {accountBillingEnabled() ? (
        <SettingsCard title="Billing" meta="Your Two Minute Billing plan">
          <SettingsLinkRow
            title="Plan and billing"
            description="Select or change your plan. See invoices and change the payment method."
            value={me.organization_live_access === "locked" ? "Live mode off" : undefined}
            href="/settings/billing"
          />
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="Account"
        meta="Your own sign-in, not the organization's. Available for all roles."
      >
        <SettingsLinkRow
          title="Password and two-factor"
          description="Change your password. Enable codes from an authenticator app for sign-in."
          value={me.email}
          href="/account"
          external
        />
      </SettingsCard>
    </SettingsShell>
  );
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  ops: "Ops",
  developer: "Developer",
};

/** Choices at or below the installation limit; the limit itself is always one of them. */
function limitOptions(steps: number[], limit: number, unit: (n: number) => string) {
  return [...steps.filter((n) => n < limit), limit].map((n) => ({
    value: String(n),
    label: n === limit ? `${unit(n)} (the limit of this installation)` : unit(n),
  }));
}

const minutes = (n: number) => (n % 60 === 0 && n >= 60 ? `${n / 60} h` : `${n} minutes`);
const hours = (n: number) => (n % 24 === 0 && n >= 24 ? `${n / 24} days` : `${n} hours`);

/**
 * The organization's session policy (0482): shorter timeouts and more roles that need 2FA than
 * the installation sets. The installation values are the ceiling and are always on.
 */
function SessionPolicyRows({
  security: s,
}: {
  security: NonNullable<Awaited<ReturnType<typeof getOrganizationSecurity>>>;
}) {
  const d = s.deployment;
  // An engine older than 0482 sends no policy: show nothing rather than a control with no backend.
  if (!d) return null;
  const idle = s.session_idle_minutes ?? d.session_idle_minutes;
  const life = s.session_absolute_ttl_hours ?? d.session_absolute_ttl_hours;
  const orgRoles = new Set(s.mfa_required_roles ?? []);
  const envRoles = new Set(d.mfa_required_roles);
  const ownRoleBlocked = !s.caller_has_two_factor && s.caller_role ? s.caller_role : null;
  return (
    <ActionForm action={saveSessionPolicyAction} className="divide-y">
      <input type="hidden" name="session_idle_minutes_limit" value={d.session_idle_minutes} />
      <input
        type="hidden"
        name="session_absolute_ttl_hours_limit"
        value={d.session_absolute_ttl_hours}
      />
      <SecurityRow
        label="Sign out after no activity"
        htmlFor="session_idle_minutes"
        help="We sign out a member who does nothing in the dashboard for this time."
        control={
          <SelectField
            name="session_idle_minutes"
            defaultValue={String(idle)}
            className="w-full sm:w-72"
            options={limitOptions(
              [5, 10, 15, 20, 30, 60, 120, 240, 480],
              d.session_idle_minutes,
              minutes,
            )}
          />
        }
      />
      <SecurityRow
        label="Maximum session length"
        htmlFor="session_absolute_ttl_hours"
        help="We sign out every member this long after they sign in, also when they are active."
        control={
          <SelectField
            name="session_absolute_ttl_hours"
            defaultValue={String(life)}
            className="w-full sm:w-72"
            options={limitOptions(
              [1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 720],
              d.session_absolute_ttl_hours,
              hours,
            )}
          />
        }
      />
      <SecurityRow
        label="Roles that must use two-factor authentication"
        help="A member with a selected role must enable 2FA before they can use the dashboard. There is no grace period."
        control={
          <div className="flex flex-col gap-2">
            {Object.entries(ROLE_LABELS).map(([role, label]) =>
              envRoles.has(role) ? (
                <CheckboxField
                  key={role}
                  label={label}
                  hint="Always necessary on this installation."
                  defaultChecked
                  disabled
                />
              ) : (
                <CheckboxField
                  key={role}
                  name="mfa_role"
                  value={role}
                  label={label}
                  hint={
                    ownRoleBlocked === role
                      ? "This is your role. Enable 2FA for yourself before you select it."
                      : undefined
                  }
                  defaultChecked={orgRoles.has(role)}
                />
              ),
            )}
          </div>
        }
      >
        <div className="flex justify-end">
          <SubmitButton>Save</SubmitButton>
        </div>
      </SecurityRow>
    </ActionForm>
  );
}

/** "8 Oct 2026" for a YYYY-MM-DD day. */
function fmtDay(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Today + `days`, as YYYY-MM-DD in `tz`: the deadline turning it on now would set. */
function dayAfter(days: number, tz: string | null): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const t = Date.parse(`${today}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** "Require two-factor authentication" (0329), its current state and who still owes a setup. */
function OrgTwoFactorRows({
  security: s,
  orgName,
  tz,
}: {
  security: NonNullable<Awaited<ReturnType<typeof getOrganizationSecurity>>>;
  orgName: string;
  tz: string | null;
}) {
  const without = s.members - s.members_with_two_factor;
  const by = s.required_by ? s.required_by.name || s.required_by.email : null;
  let status: string | null = null;
  if (s.require_two_factor) {
    const since = s.required_since
      ? new Date(s.required_since).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;
    const parts = [since ? `Required since ${since}${by ? `. Enabled by ${by}.` : "."}` : null];
    if (s.members_in_grace > 0)
      parts.push(
        s.members_in_grace_deadline_day
          ? `${s.members_in_grace} ${s.members_in_grace === 1 ? "member has" : "members have"} until ${fmtDay(s.members_in_grace_deadline_day)} to enable it.`
          : `${s.members_in_grace} ${s.members_in_grace === 1 ? "member is" : "members are"} still in the grace period.`,
      );
    if (s.members_blocked > 0)
      parts.push(
        `${s.members_blocked} ${s.members_blocked === 1 ? "member" : "members"} without 2FA cannot open ${orgName} until they enable it.`,
      );
    parts.push(
      "New members must enable 2FA when they join. While this setting is on, members cannot disable 2FA.",
    );
    status = parts.filter(Boolean).join(" ");
  }
  return (
    <>
      <SecurityRow
        label="Require two-factor authentication"
        help={`To open this organization, all members of ${orgName} must enable two-factor authentication.`}
        placement="end"
        control={
          <RequireTwoFactorSwitch
            required={s.require_two_factor}
            disabled={!s.caller_has_two_factor}
            orgName={orgName}
            membersWithout={without}
            deadlineIfOnToday={fmtDay(dayAfter(s.grace_days, tz))}
          />
        }
        consequence={status ?? undefined}
      >
        {!s.require_two_factor && !s.caller_has_two_factor ? (
          <p className="m-0 text-sm text-muted-foreground">
            Enable 2FA for yourself before you make it necessary for the organization.{" "}
            <Link href="/account#two-factor" className="text-primary hover:underline">
              Enable 2FA
            </Link>
          </p>
        ) : null}
      </SecurityRow>
      <SecurityRow
        label="Members with two-factor authentication"
        help={`${s.members_with_two_factor} of ${s.members} ${s.members === 1 ? "member has" : "members have"} 2FA on.`}
        placement="end"
        control={
          <Link href="/team" className="text-sm text-primary hover:underline">
            See members
          </Link>
        }
      />
    </>
  );
}
