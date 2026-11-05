import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "@/lib/api";
import { orgTz } from "@/lib/org-tz-server";
import { requirePermission } from "@/lib/session";
import {
  accountBillingEnabled,
  getAccountBilling,
  type AccountBilling,
  type PlanPrice,
} from "@/lib/account-billing";
import { money, fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import { ActionButton } from "@/components/action-button";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Chip } from "@/components/patterns/chip";
import { ErrorState } from "@/components/states";
import { choosePlanAction } from "./actions";

export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Settings", href: "/settings" }, { label: "Billing" }];
/** The website's contact page (F1). */
const CONTACT_URL =
  process.env.ACCOUNT_BILLING_CONTACT_URL ?? "https://twominutebilling.com/contact";

/**
 * Our plan for this organization (F4). Cloud only: a self-hosted copy has no account billing,
 * so this route does not exist there.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ interval?: string; done?: string; portal_error?: string }>;
}) {
  if (!accountBillingEnabled()) notFound();
  await requirePermission("settings:manage", "admin");
  const { interval: wanted, done, portal_error: portalError } = await searchParams;
  // An organization screen: no single business applies, so the organization's timezone.
  const tz = await orgTz();
  let account: AccountBilling;
  try {
    account = await getAccountBilling((await getMe()).id);
  } catch (e) {
    return (
      <SettingsPage title="Billing" crumbs={CRUMBS}>
        <ErrorState title="We could not load your plan" description={(e as Error).message} />
      </SettingsPage>
    );
  }

  const interval = wanted === "year" ? "year" : (account.plan?.interval ?? "month");
  const shown = account.prices.filter((p) => p.interval === interval);
  const band = account.limit_minor;
  const used = account.usage.volume_minor;
  const over = account.over_limit;
  // The smallest plan that covers what was billed this month.
  const next =
    over && used != null
      ? shown.find((p) => p.volume_limit_minor != null && p.volume_limit_minor >= used)
      : undefined;
  const overLimitRestricted =
    account.status === "restricted" && account.restricted_reason === "over_limit";

  return (
    <SettingsPage
      title="Billing"
      description="Your Two Minute Billing plan. Every plan has every feature. Plans differ only in how much you bill each month."
      crumbs={CRUMBS}
    >
      {portalError ? (
        <Alert tone="error" title="We could not open the billing portal">
          Try again. If it fails again, contact us.
        </Alert>
      ) : null}
      {overLimitRestricted ? (
        <Alert tone="error" title="Your organization is read-only">
          You billed more than your plan covers, so you cannot make changes. Your customers are
          still billed. Change to a plan that covers your billing to make changes again.
        </Alert>
      ) : account.status === "restricted" ? (
        <Alert tone="error" title="Your organization is read-only">
          Your plan was not paid, so you cannot make changes. Your customers are still billed. Pay
          the open invoice to make changes again.
        </Alert>
      ) : done && account.plan ? (
        <Alert tone="success" title="Your plan is active">
          Your plan now covers up to {money(account.plan.volume_limit_minor, account.currency)} a
          month.
        </Alert>
      ) : account.live_access === "locked" ? (
        <Alert tone="info" title="Live mode is off">
          Test mode has every feature. Contact us to turn live mode on.
        </Alert>
      ) : null}
      {over && !overLimitRestricted ? (
        <Alert tone="warning" title="You billed more than your plan covers this month">
          Your billing carries on.{" "}
          {next
            ? `Change to ${next.name} to cover up to ${money(next.volume_limit_minor, next.currency)} a month.`
            : "Contact us about an Enterprise plan."}{" "}
          If you stay above the limit, we can make your dashboard read-only until you change plan.
        </Alert>
      ) : null}

      <SettingsCard
        title="Current plan"
        actions={
          account.plan || account.restricted_reason === "unpaid" ? (
            // A plain link, not a client navigation: the portal link it opens is single-use.
            <Button asChild size="sm" variant="outline">
              <a href="/settings/billing/portal">Invoices and payment method</a>
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Plan</div>
            <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
              {account.plan ? account.plan.name : account.agreement ? "Custom agreement" : "Free"}
              {account.plan ? (
                <Chip>{`${money(account.plan.amount_minor, account.plan.currency)} / ${account.plan.interval}`}</Chip>
              ) : account.agreement ? (
                <Chip tone="green">Live mode on</Chip>
              ) : (
                <Chip tone="green">Live mode on</Chip>
              )}
            </div>
            {account.plan?.renews_at ? (
              <div className="mt-1 text-sm text-muted-foreground">
                Renews on {fmtDate(account.plan.renews_at, tz)}
              </div>
            ) : null}
            {band != null ? (
              <div className="mt-1 text-sm text-muted-foreground">
                {account.plan
                  ? `Bill up to ${money(band, account.currency)} a month in live mode. Every feature.`
                  : `Free while you make less than ${money(band, account.currency)} a month. Every feature.`}
              </div>
            ) : null}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Billed this month (live mode)</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {money(used, account.currency)}
              {band != null ? (
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}
                  of {money(band, account.currency)}
                </span>
              ) : null}
            </div>
            {band != null && used != null ? (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "anim-grow h-full rounded-full",
                    over ? "bg-warning" : "bg-primary",
                  )}
                  style={{ width: `${Math.min(100, (used / band) * 100)}%` }}
                />
              </div>
            ) : null}
            <div className="mt-1 text-xs text-muted-foreground">
              {account.usage.note
                ? "We cannot calculate this yet: an exchange rate is missing."
                : "Payments you collected, less refunds. Updated every night."}
            </div>
          </div>
        </div>
      </SettingsCard>

      {account.agreement ? (
        <SettingsCard title="Plans">
          <p className="px-5 py-4 text-sm text-muted-foreground">
            Your organization is on a custom agreement, so there is no plan to select here.{" "}
            <a href={CONTACT_URL} className="text-primary hover:underline">
              Contact us
            </a>{" "}
            to change it.
          </p>
        </SettingsCard>
      ) : (
        <SettingsCard
          title="Plans"
          meta={`Prices in ${account.currency}, before tax.`}
          actions={
            <div className="flex gap-1">
              {(["month", "year"] as const).map((i) => (
                <Link
                  key={i}
                  href={`/settings/billing?interval=${i}`}
                  aria-current={i === interval ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-sm",
                    i === interval
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {i === "month" ? "Monthly" : "Yearly · 20% off"}
                </Link>
              ))}
            </div>
          }
        >
          <div className="grid gap-4 p-5 md:grid-cols-3">
            {shown.map((p) => (
              <PlanCard key={p.id} price={p} account={account} />
            ))}
          </div>
          <p className="px-5 pb-5 text-sm text-muted-foreground">
            Bill more than {money(shown.at(-1)?.volume_limit_minor ?? null, account.currency)} a
            month, or need a contract?{" "}
            <a href={CONTACT_URL} className="text-primary hover:underline">
              Contact us about Enterprise
            </a>
            .
          </p>
        </SettingsCard>
      )}
    </SettingsPage>
  );
}

/** A price with no cents when the amount is whole ("$29", not "$29.00"). */
function whole(minor: number, currency: string): string {
  return minor % 100 === 0
    ? money(minor, currency).replace(/[.,]00(?=\D*$)/, "")
    : money(minor, currency);
}

function PlanCard({ price, account }: { price: PlanPrice; account: AccountBilling }) {
  const monthly =
    price.interval === "year"
      ? account.prices.find(
          (m) => m.tier === price.tier && m.currency === price.currency && m.interval === "month",
        )
      : undefined;
  const current = account.plan?.price === price.id;
  const otherCurrency = account.plan != null && account.plan.currency !== price.currency;
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card p-4",
        current && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold">{price.name}</div>
        {current ? <Chip tone="blue">Current plan</Chip> : null}
      </div>
      {/* Yearly reads per month — what a month costs — with the monthly price struck beside it. */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold tabular-nums">
        {monthly ? (
          <span className="text-base font-normal text-muted-foreground line-through">
            {whole(monthly.amount_minor, price.currency)}
          </span>
        ) : null}
        {whole(
          price.interval === "year"
            ? Math.round(price.amount_minor / 12 / 100) * 100
            : price.amount_minor,
          price.currency,
        )}
        <span className="text-sm font-normal text-muted-foreground">/ month</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {price.interval === "year"
          ? `Billed yearly at ${whole(price.amount_minor, price.currency)}`
          : "Billed monthly"}
      </div>
      <div className="mt-1 text-sm text-muted-foreground">
        Bill up to {money(price.volume_limit_minor, price.currency)} a month. Every feature.
      </div>
      <div className="mt-4">
        {current || otherCurrency ? null : (
          <ActionButton
            resultAction={choosePlanAction}
            fields={{ price: price.id }}
            label={`Change to ${price.name}`}
            variant={account.plan ? "outline" : "default"}
            className="w-full"
          />
        )}
      </div>
    </div>
  );
}
