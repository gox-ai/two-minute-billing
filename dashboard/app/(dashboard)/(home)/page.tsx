import * as React from "react";
import Link from "next/link";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { getMe, listBusinesses, money } from "@/lib/api";
import {
  queryAnalytics,
  AnalyticsRefused,
  type BatchEntry,
  getSyncedAt,
} from "@/lib/analytics-api";
import { Stack } from "@/components/analytics/layout";
import { CutMenu } from "@/components/analytics/cut-controls";
import { CurrencyRefusal } from "@/components/analytics/currency-refusal";
import {
  ok,
  splitByKey,
  billedCurrencies,
  excludedBusinesses,
  windowChangeBps,
} from "@/components/analytics/org/conversion";
import { ConversionNote } from "@/components/analytics/org/conversion-note";
import { createBusiness } from "@/app/actions";
import { requireUser, can, allows } from "@/lib/session";
import { permissionDef, type PermissionKey } from "@/lib/permissions.generated";
import { plural } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SyncedBadge } from "@/components/analytics/synced-badge";
import { PageHeader } from "@/components/page-header";
import { CreateDialog } from "@/components/create-dialog";
import { Field } from "@/components/form/field";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { CurrencySelect } from "@/components/form/currency-select";
import { WelcomeFirstBusiness } from "@/components/home/welcome-first-business";
import { currencyForCountry } from "@/lib/country-currency";
import { OrgTotals, totalsQueries, windowQueries } from "@/components/overview/totals";
import { ZoneHeading } from "@/components/analytics/home/zone";
import { orgTz } from "@/lib/org-tz-server";
import { loadAttention } from "@/components/overview/attention";
import { AttentionList } from "@/components/overview/attention-list";
import type { RosterRow } from "@/components/analytics/org/business-roster";
import { BusinessCards, BusinessPanel } from "@/components/analytics/org/business-cards";
import { SectionHeading } from "@/components/overview/section-heading";
import { OverviewSkeleton } from "@/components/overview/overview-skeleton";

export const dynamic = "force-dynamic";

/**
 * What each permission actually gates, in the operator's words rather than the enum's.
 * `requirePermission()` refuses in terms of `manager` / `ops` / `developer` / `admin`; nobody
 * knows which pages those cover, so the notice names the pages.
 */
const DENIED_AREAS: Record<string, string> = {
  manager: "customers, subscriptions and the product catalog",
  ops: "invoices, credit notes and the operational logs",
  developer: "API keys, webhooks and the developer tools",
  admin: "organization settings, the team and the audit log",
};

/** A batch slot that came back refused, as the refusal the screen already knows how to render. */
function refusalOf(entry: BatchEntry | undefined): AnalyticsRefused | null {
  if (!entry || entry.object !== "analytics_error") return null;
  return new AnalyticsRefused(entry.error.message, {
    param: entry.error.param,
    options: entry.error.options,
  });
}

/**
 * Organization overview: the organization's totals (the same figures and conversion as the
 * Current zone on Metrics), what needs a person today, and the way into each business.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; currency?: string }>;
}) {
  const user = await requireUser();
  const isManager = allows(user, "businesses:create", "manager");

  /**
   * `requirePermission()` sends a role that lacks a permission here as `/?denied=<perm>`.
   * Shown only when the role GENUINELY lacks it: a stale bookmark must not tell an owner they
   * cannot open a page they can.
   */
  const { denied, currency: currencyParam } = await searchParams;
  const deniedPerm =
    denied && denied in DENIED_AREAS ? (denied as "manager" | "ops" | "developer" | "admin") : null;
  // A custom role is refused by permission key: name the permission.
  const deniedKey = !deniedPerm && denied ? permissionDef(denied) : undefined;
  const deniedNotice =
    deniedKey && !allows(user, deniedKey.key as PermissionKey) ? (
      <Alert tone="warning" title="That page is not available to your role" className="mb-4">
        Your role does not have this permission: {deniedKey.label}. An organization admin can change
        your role in Team.
      </Alert>
    ) : deniedPerm && !can(user.role, deniedPerm) ? (
      <Alert tone="warning" title="That page is not available to your role" className="mb-4">
        You are signed in as <span className="font-medium">{user.role}</span>. This role does not
        include {DENIED_AREAS[deniedPerm]}. An organization admin can change your role in Team.
      </Alert>
    ) : null;

  let org, businesses;
  try {
    [org, businesses] = await Promise.all([getMe(), listBusinesses()]);
  } catch (e) {
    return (
      <>
        {deniedNotice}
        <ErrorState
          title="We could not connect to the billing API"
          description={
            <>
              Check <code className="font-mono">TMBILLING_API_URL</code> in{" "}
              <code className="font-mono">dashboard/.env.local</code>. Make sure that the API is
              running.
              <br />
              <span className="font-mono text-xs">{(e as Error).message}</span>
            </>
          }
        />
      </>
    );
  }

  // Organization figures are live: test mode lives inside each business, beside its live data.
  const visible = businesses.data.filter((b) => b.livemode === "live");
  // Test businesses made before every business had its own test mode. They have no live
  // business, so this list is the only way in.
  const legacyTest = businesses.data.filter((b) => b.livemode === "test" && !b.live_business_id);

  // No business yet: the page's only job is creating the first one.
  if (visible.length === 0 && legacyTest.length === 0 && isManager) {
    return (
      <>
        {deniedNotice}
        <WelcomeFirstBusiness
          personName={user.name ?? null}
          country={user.organization_country ?? null}
          signupGateway={user.organization_signup_gateway ?? null}
        />
      </>
    );
  }

  /**
   * Two calls, side by side. The totals ask Metrics' Current questions on its basis, so the
   * two pages agree. The 30-day call carries the movement, churn, trials and the
   * Performance section, on the 30-day daily window those figures always used.
   */
  const sole = visible.length === 1 ? visible[0]! : null;
  let batch: BatchEntry[] = [];
  let windowBatch: BatchEntry[] = [];
  let batchError: string | null = null;
  const syncedAtP = getSyncedAt();
  const tzP = orgTz();
  if (visible.length > 0) {
    try {
      [batch, windowBatch] = await Promise.all([
        queryAnalytics({
          queries: totalsQueries(businesses.data.length),
          ...(currencyParam ? { currency: currencyParam } : {}),
        }),
        queryAnalytics({
          range: "30d",
          grain: "day",
          queries: windowQueries({
            businessCount: businesses.data.length,
            soleBusiness: sole?.id ?? null,
            currency: currencyParam,
          }),
        }),
      ]);
    } catch (e) {
      batchError = (e as Error).message;
    }
  }
  const [syncedAt, tz] = await Promise.all([syncedAtP, tzP]);
  const answers = new Map(batch.map((e) => [e.key, e]));
  const windowAnswers = new Map(windowBatch.map((e) => [e.key, e]));

  const mrr = ok(answers.get("mrr"));
  const mrrRefusal = refusalOf(answers.get("mrr"));
  const payingBiz = splitByKey(ok(answers.get("paying_biz")));
  const dunningBiz = splitByKey(ok(answers.get("dunning_biz")));
  const payingSubsBiz = splitByKey(ok(windowAnswers.get("paying_by_biz")));
  const mrrMoveResult = ok(windowAnswers.get("mrr_by_biz"));
  const mrrMoveBiz = splitByKey(mrrMoveResult);
  /** The 30-day MRR: the Performance section's basis. */
  const windowMrr = ok(windowAnswers.get("mrr"));
  const payingTotal = [...payingBiz.values()].reduce((s, r) => s + (r.total ?? 0), 0);
  /** Live businesses exist, but none has billed anything yet. */
  const dormant = visible.length > 0 && !mrr?.total && payingTotal === 0;
  /** Businesses the conversion left out: named, never counted as zero. */
  const dropped = new Set(excludedBusinesses(visible, mrr?.missing_rates ?? []).map((b) => b.id));

  const attention =
    visible.length > 0
      ? await loadAttention({ user, orgName: org.name, orgTz: tz, businesses: visible, answers })
      : [];

  /**
   * One row per live business for the cards and the roster, as before: MRR and its 30-day
   * movement on the page's reporting basis, stated in ONE currency, converted. A business
   * whose currency has no rate converts to nothing and is named, not shown as zero.
   */
  const rosterCurrency = mrrMoveResult?.currency ?? windowMrr?.currency ?? null;
  const rows: RosterRow[] = visible.map((b) => {
    const mrrRow = mrrMoveBiz.get(b.id);
    return {
      id: b.id,
      name: b.name,
      livemode: b.livemode,
      currency: b.default_currency,
      mrrLabel:
        mrrRow?.total != null && rosterCurrency ? money(mrrRow.total, rosterCurrency) : null,
      mrrMinor: mrrRow?.total ?? null,
      changeBps: mrrRow ? windowChangeBps(mrrRow.points) : null,
      payingSubscriptions: payingSubsBiz.get(b.id)?.total ?? null,
      subscriptionsInDunning: dunningBiz.get(b.id)?.total ?? null,
      excludedFromRollup: dropped.has(b.id),
      iconUrl: b.icon_url ?? null,
      brandColor: b.brand_color ?? null,
    };
  });
  /** One business: the organization's totals are its totals, so its panel holds them. */
  const only = rows.length === 1 ? rows[0]! : null;
  const panel = only && windowMrr && !dormant ? only : null;

  const totalsProps = {
    answers,
    window: windowAnswers,
    businessCount: visible.length,
    includedCount: visible.length - dropped.size,
    soleBusiness: sole?.id ?? null,
  };

  /** The currencies the book is billed in: the reporting currency control's options. */
  const currencies = billedCurrencies(businesses.data);
  const currencySwitcher =
    currencies.length > 1 && !dormant ? (
      <CutMenu
        label="Reporting currency"
        current={currencyParam ?? ""}
        active={!!currencyParam}
        options={[
          {
            id: "",
            label: mrr?.currency ? `Reported in ${mrr.currency}, converted` : "Converted",
            href: "/",
          },
          ...currencies.map((c) => ({ id: c, label: `${c} only`, href: `/?currency=${c}` })),
        ]}
      />
    ) : null;

  const createControl = isManager ? (
    <CreateDialog
      triggerSize="sm"
      triggerLabel="Create business"
      title="Create business"
      description="Each business has a live mode and a test mode. Use test mode to try your setup before you bill real customers."
    >
      <form action={createBusiness} className="space-y-4">
        <Field name="name" label="Business name" required>
          <Input name="name" placeholder="New business name" required />
        </Field>
        <Field
          name="default_currency"
          label="Default currency"
          help="The currency this business prices and invoices in."
          required
        >
          <CurrencySelect
            name="default_currency"
            defaultValue={currencyForCountry(user.organization_country)}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit">Create business</Button>
        </div>
      </form>
    </CreateDialog>
  ) : null;

  const listed = visible.length + legacyTest.length;

  return (
    <NavPendingProvider>
      <PageHeader
        title={org.name}
        description={plural(listed, "business", "businesses")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {visible.length > 0 ? <SyncedBadge syncedAt={syncedAt} /> : null}
            {currencySwitcher}
            {createControl}
          </div>
        }
      />

      {deniedNotice}

      <PendingContent skeleton={<OverviewSkeleton />}>
        <Stack>
          {/* The way into each business: the largest by MRR as cards. One business with
              revenue is the panel in the totals instead. */}
          {panel ? null : (
            <section aria-label="Businesses" className="flex flex-col gap-6">
              <ZoneHeading zone="businesses" />
              <BusinessCards rows={rows} currency={rosterCurrency} allHref="/metrics" />
              {dormant ? (
                <p className="text-sm text-muted-foreground">
                  Revenue, subscriptions and cash show here after the first live subscription. Open
                  a business to set up its catalog, or turn on Test mode to try your setup first.
                </p>
              ) : null}
            </section>
          )}

          {visible.length > 0 ? (
            <section aria-labelledby="org-totals" className="mt-4 flex flex-col gap-4">
              <SectionHeading
                id="org-totals"
                title="Organization totals"
                meta="All live businesses"
                action={
                  allows(user, "reports:view", "ops")
                    ? { href: "/metrics", label: "View metrics" }
                    : undefined
                }
              />
              {batchError ? (
                <ErrorState
                  title="We could not read the organization’s figures"
                  description={<span className="font-mono text-xs">{batchError}</span>}
                />
              ) : null}
              {/* No base currency: the engine refuses a cross-currency total and names the
                  currencies it CAN answer. Its sentence, its options. */}
              {mrrRefusal ? (
                <CurrencyRefusal refusal={mrrRefusal} hrefFor={(c) => `/?currency=${c}`} />
              ) : null}
              {panel ? (
                /* One business with revenue: its panel heads its own figures, as before. */
                <BusinessPanel row={panel}>
                  <OrgTotals {...totalsProps} bare />
                </BusinessPanel>
              ) : (
                <OrgTotals {...totalsProps} />
              )}
            </section>
          ) : null}

          {attention.length > 0 ? (
            <section aria-labelledby="org-attention" className="mt-4 flex flex-col gap-4">
              <SectionHeading
                id="org-attention"
                title="Needs attention"
                meta={plural(attention.length, "item")}
              />
              <AttentionList rows={attention} />
            </section>
          ) : null}

          {legacyTest.length > 0 ? (
            <Alert tone="info" title="Standalone test businesses">
              These test businesses were created before each business had its own test mode. They
              continue to work:{" "}
              {legacyTest.map((b, i) => (
                <React.Fragment key={b.id}>
                  {i > 0 ? ", " : null}
                  <Link href={`/businesses/${b.id}`}>{b.name}</Link>
                </React.Fragment>
              ))}
              .
            </Alert>
          ) : null}

          {/* The last line: the basis of the totals, and what the conversion had to leave out. */}
          {mrr ? <ConversionNote result={mrr} businesses={visible} /> : null}
        </Stack>
      </PendingContent>
    </NavPendingProvider>
  );
}
