import * as React from "react";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { OrgHomeSkeleton } from "@/components/analytics/org/skeletons";
import Link from "next/link";
import { getMe, listBusinesses, listCustomers, money } from "@/lib/api";
import {
  queryAnalytics,
  AnalyticsRefused,
  type AnalyticsQuery,
  type BatchEntry,
  type AnalyticsResult,
  getSyncedAt,
} from "@/lib/analytics-api";
import { measureValueCompact } from "@/components/analytics/format";
import { pctFromBps } from "@/lib/format";
import { Grid, Stack, Block } from "@/components/analytics/layout";
import { CutMenu } from "@/components/analytics/cut-controls";
import { CurrencyRefusal } from "@/components/analytics/currency-refusal";
import {
  ok,
  splitByKey,
  windowChangeBps,
  billedCurrencies,
  excludedBusinesses,
  type ConvertedResult,
} from "@/components/analytics/org/conversion";
import { ConversionNote } from "@/components/analytics/org/conversion-note";
import { OrgPerformance, orgPerformanceQueries } from "@/components/analytics/org/performance";
import { combineQueueCounts, fetchQueueCounts, queueItems } from "@/lib/attention-queues";
import { orgTz } from "@/lib/org-tz-server";
import {
  AttentionStrip,
  Headline,
  seriesChange,
  trialHalves,
  type AttentionItem,
} from "@/components/analytics/home/parts";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import { BusinessRoster, type RosterRow } from "@/components/analytics/org/business-roster";
import { BusinessCards, BusinessPanel } from "@/components/analytics/org/business-cards";
import { createBusiness } from "@/app/actions";
import { requireUser, can, allows } from "@/lib/session";
import { permissionDef, type PermissionKey } from "@/lib/permissions.generated";
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
import { explain } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";

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
 * Organization home.
 *
 * One converted portfolio figure, what the conversion had to drop said plainly, which business
 * wants attention today, and then the businesses themselves — **each row in its own currency**.
 * Every analytics figure on the screen comes from ONE batched POST.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; currency?: string }>;
}) {
  const user = await requireUser();
  const isManager = allows(user, "businesses:create", "manager");

  /**
   * `requirePermission()` sends a role that lacks a permission here as `/?denied=<perm>`, and
   * nothing read that parameter — so the click simply undid itself and the refusal sat unread
   * in the URL. Rendered in the error branch below too: a `developer` cannot list businesses
   * either, so the bounce and the failed fetch arrive together.
   */
  const { denied, currency: currencyParam } = await searchParams;
  /**
   * Shown only when the role GENUINELY lacks the permission — the parameter is just a query
   * string, and a stale bookmark would otherwise tell an owner they cannot open a page they can.
   */
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

  // Org-level views are live: test mode lives inside each business, beside its live data.
  const mode = "live" as const;
  const visible = businesses.data.filter((b) => b.livemode === mode);
  // Test businesses created before every business had its own test mode. They have no live
  // business, so the only way in is from here.
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

  /** The currencies the book is actually billed in, most common first — the switcher's options. */
  const currencies = billedCurrencies(businesses.data);

  /**
   * ONE round trip for every figure on this page.
   *
   * The headline asks for no currency, so the engine converts into the organization's base
   * currency and publishes the rates it used and the ones it could not find. The roster's
   * split rides the SAME basis, so a row and the headline are the same arithmetic — one
   * query, not one per currency the book happens to use.
   *
   * `range: 30d` on a stock answers two questions at once: the total is the value at the END
   * of the window (what MRR is now), and each split row's points carry where it started, which
   * is the 30-day movement the roster shows.
   */
  const reporting = currencyParam ? { currency: currencyParam } : {};
  /**
   * One business: its figures read like its own Home, so ask for the per-business ones Home
   * shows. ARPC is a ratio the organization scope refuses, so both name the business.
   */
  const sole = visible.length === 1 ? visible[0]! : null;
  const soleQueries: AnalyticsQuery[] = sole
    ? [
        { key: "sole_cmrr", measure: "cmrr", business: sole.id, ...reporting },
        {
          key: "sole_cust_churn",
          measure: "customer_churn_rate",
          business: sole.id,
          range: "30d",
          grain: "month",
        },
        {
          key: "sole_arpa",
          measure: "revenue_per_paying_customer",
          business: sole.id,
          ...reporting,
        },
      ]
    : [];
  const queries: AnalyticsQuery[] = [
    { key: "mrr", measure: "mrr", compare: "previous", ...reporting },
    { key: "arr", measure: "arr", ...reporting },
    ...soleQueries,
    { key: "paying_customers", measure: "paying_customers" },
    { key: "paying", measure: "paying_subscriptions" },
    { key: "renewing", measure: "renewing_subscriptions" },
    ...orgPerformanceQueries(reporting),
    { key: "at_risk", measure: "mrr_at_risk", ...reporting },
    { key: "cancel_mrr", measure: "scheduled_cancellation_mrr", split: "horizon", ...reporting },

    {
      // Subscriptions in dunning, per business — the roster's Dunning column.
      key: "dunning_by_biz",
      measure: "dunning_subscriptions",
      split: "business",
      split_limit: Math.max(businesses.data.length, 1),
    },
    {
      key: "paying_by_biz",
      measure: "paying_subscriptions",
      split: "business",
      split_limit: Math.max(businesses.data.length, 1),
    },
    {
      key: "mrr_by_biz",
      measure: "mrr",
      split: "business",
      split_limit: Math.max(businesses.data.length, 1),
      ...reporting,
    },
  ];

  let batch: BatchEntry[] = [];
  let batchError: string | null = null;
  const syncedAtP = getSyncedAt();
  try {
    batch = await queryAnalytics({ range: "30d", grain: "day", queries });
  } catch (e) {
    batchError = (e as Error).message;
  }
  const syncedAt = await syncedAtP;
  const byKey = new Map(batch.map((e) => [e.key, e]));

  const mrr: ConvertedResult | null = ok(byKey.get("mrr"));
  const mrrRefusal = refusalOf(byKey.get("mrr"));
  const paying = ok(byKey.get("paying"));
  const renewing = ok(byKey.get("renewing"));
  const payingByBiz = splitByKey(ok(byKey.get("paying_by_biz")));
  const dunningByBiz = splitByKey(ok(byKey.get("dunning_by_biz")));
  /** Businesses exist in this mode, but none has billed anything — nothing to chart or total. */
  const dormant =
    visible.length > 0 &&
    (mrr?.total == null || mrr.total === 0) &&
    (paying?.total == null || paying.total === 0);

  /**
   * Per-business MRR on the page's own reporting basis, plus that row's movement.
   *
   * Stated in ONE currency, converted, rather than each business's own: minor units across
   * currencies do not add, so a business billing in three used to render as three figures
   * joined by a `+` — an arithmetic nobody can do, wrapped over four lines. A business whose
   * currency has no rate converts to nothing and is named below instead of shown as zero.
   */
  const mrrByBizResult = ok(byKey.get("mrr_by_biz"));
  const mrrByBiz = splitByKey(mrrByBizResult);
  /** The currency every roster figure is stated in — the same one the headline uses. */
  const reportingCurrency = mrrByBizResult?.currency ?? mrr?.currency ?? null;

  /** Businesses the converted headline had to leave out, by name — never counted as zero. */
  const dropped = new Set(excludedBusinesses(visible, mrr?.missing_rates ?? []).map((b) => b.id));

  /** The business holding most of a split — where a cell's link leads. */
  const topOf = (key: string) => {
    const split = splitByKey(ok(byKey.get(key)));
    return (
      visible
        .map((b) => ({ b, v: split.get(b.id)?.total ?? 0 }))
        .filter((r) => r.v > 0)
        .sort((a, z) => z.v - a.v)[0]?.b ?? null
    );
  };
  const atRisk = ok(byKey.get("at_risk"));
  const inDunning = [...dunningByBiz.values()].reduce((s, r) => s + (r.total ?? 0), 0);
  const cancelResult = ok(byKey.get("cancel_mrr"));
  // Every band, not just the next 30 days: Committed subtracts them all, and the link lists them all.
  const cancelling = cancelResult?.total ?? 0;
  const dunningTop = topOf("dunning_by_biz");

  // Renewing customers who cannot be charged, and those whose card is expiring, per business: the
  // customers list's own counts through its filters, so each cell and its list agree.
  const stuckFilter = [{ field: "cannot_be_charged", op: "is", value: "true" }];
  // Started before the customer counts below so the two run side by side.
  const queuesP = Promise.all([
    Promise.all(visible.map(async (b) => ({ biz: b.id, counts: await fetchQueueCounts(b.id) }))),
    orgTz(),
  ]).then(([per, tz]) => {
    const { counts, topBiz } = combineQueueCounts(per);
    return queueItems(counts, topBiz, tz);
  });
  const stuckByBiz = await Promise.all(
    visible.map(async (b) => {
      const [all, none, expiring] = await Promise.all([
        // `exactTotal`: these totals are figures on the tile, not "N rows".
        listCustomers(b.id, { limit: 1, exactTotal: true, filters: stuckFilter }),
        listCustomers(b.id, {
          limit: 1,
          exactTotal: true,
          filters: [
            ...stuckFilter,
            { field: "payment_method_type", op: "is_present", value: "false" },
          ],
        }),
        listCustomers(b.id, {
          limit: 1,
          exactTotal: true,
          filters: [
            { field: "payment_method_expiring", op: "is", value: "true" },
            { field: "renewing", op: "is", value: "true" },
          ],
        }),
      ]).catch(() => [null, null, null] as const);
      return {
        b,
        total: all?.total ?? 0,
        noMethod: none?.total ?? 0,
        expiring: expiring?.total ?? 0,
      };
    }),
  );
  const stuck = stuckByBiz.reduce((s, r) => s + r.total, 0);
  const stuckNone = stuckByBiz.reduce((s, r) => s + r.noMethod, 0);
  const stuckTop =
    [...stuckByBiz].sort((a, z) => z.total - a.total).find((r) => r.total > 0)?.b ?? null;
  const stuckNote = [
    stuck - stuckNone > 0 ? `${(stuck - stuckNone).toLocaleString("en")} expired or invalid` : null,
    stuckNone > 0 ? `${stuckNone.toLocaleString("en")} no method` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The same queues as Business Home: three always (an empty one reads a quiet zero and links to
  // Metrics, a full one to the business holding most of it), up to three more while non-empty.
  const cards = stuckByBiz.reduce((s, r) => s + r.expiring, 0);
  const cardsTop =
    [...stuckByBiz].sort((a, z) => z.expiring - a.expiring).find((r) => r.expiring > 0)?.b ?? null;
  const atRiskMinor = atRisk?.total ?? 0;
  const attentionItems: AttentionItem[] = [
    {
      key: "at_risk",
      label: "MRR at risk",
      value: money(atRiskMinor, atRisk?.currency ?? "USD"),
      note: inDunning ? `${inDunning.toLocaleString("en")} in dunning` : undefined,
      href: dunningTop ? `/businesses/${dunningTop.id}/retries` : "/metrics",
      tone: atRiskMinor > 0 ? "attention" : "neutral",
      info: G.mrrAtRisk,
    },
    {
      key: "cannot_charge",
      label: "Cannot be charged",
      value: stuck.toLocaleString("en"),
      note: stuckNote || undefined,
      href: stuckTop
        ? `/businesses/${stuckTop.id}/customers?filter=cannot_be_charged:is:true`
        : "/metrics",
      tone: stuck > 0 ? "attention" : "neutral",
      info: G.cantBeCharged,
    },
    {
      key: "cards",
      label: "Cards expiring",
      value: cards.toLocaleString("en"),
      note: "next 90 days",
      href: cardsTop
        ? `/businesses/${cardsTop.id}/customers?filter=payment_method_expiring:is:true&filter=renewing:is:true`
        : "/metrics",
      tone: cards > 0 ? "warning" : "neutral",
      info: G.cardsExpiring,
    },
    ...(await queuesP),
  ];

  const rows: RosterRow[] = visible.map((b) => {
    const mrrRow = mrrByBiz.get(b.id);
    return {
      id: b.id,
      name: b.name,
      livemode: b.livemode,
      currency: b.default_currency,
      mrrLabel:
        mrrRow?.total != null && reportingCurrency ? money(mrrRow.total, reportingCurrency) : null,
      mrrMinor: mrrRow?.total ?? null,
      changeBps: mrrRow ? windowChangeBps(mrrRow.points) : null,
      payingSubscriptions: payingByBiz.get(b.id)?.total ?? null,
      subscriptionsInDunning: dunningByBiz.get(b.id)?.total ?? null,
      excludedFromRollup: dropped.has(b.id),
      iconUrl: b.icon_url ?? null,
      brandColor: b.brand_color ?? null,
    };
  });
  /** One business: the organization's totals are its totals, so nothing is combined or compared. */
  const only = rows.length === 1 ? rows[0]! : null;
  const arr = ok(byKey.get("arr"));
  const soleCmrr = ok(byKey.get("sole_cmrr"));
  const soleArpa = ok(byKey.get("sole_arpa"));
  const payingCustomers = ok(byKey.get("paying_customers"));
  /** Links into the only business, the same ones its Home carries. */
  const subsHref = only ? `/businesses/${only.id}/subscriptions` : null;
  /** The headline row's fixed 30 days — the same window the Performance zone reads. */
  const money30 = (key: string) => ok(byKey.get(key))?.total ?? null;
  const cur = mrr?.currency ?? reportingCurrency ?? "USD";
  const hTrial = trialHalves(ok(byKey.get("p_trial_conv")));
  const hTrialConv = money30("p_trial_conv");
  const hMrrNew = money30("p_new");
  const hChurned = money30("p_churn");
  const hMrrChurn = ok(byKey.get("p_churn_rate"));
  const soleCustChurn = ok(byKey.get("sole_cust_churn"));

  /**
   * The reporting currency control. "Converted" is the engine's own default — it sums into the
   * organization's base currency using the rates on file — and each billed currency is the
   * un-converted alternative. Every option is a real value of the API's `currency` param.
   */
  const currencySwitcher =
    currencies.length > 1 ? (
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
      // Secondary once businesses exist; with none, creating one is the page's only action.
      triggerVariant={visible.length > 0 ? "outline" : "default"}
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

  /**
   * The four figures. With one business they are that business's, so they sit inside its panel
   * rather than beside a card repeating them.
   */
  const figures = mrr ? (
    <>
      <Headline
        span={3}
        bare={!!only}
        label={only ? "MRR" : "Consolidated MRR"}
        info={
          only
            ? explain(G.mrr, G.arr, G.cmrr, G.cancelling)
            : explain(G.consolidatedMrr, G.businesses, G.cancelling)
        }
        change={seriesChange(mrr as unknown as AnalyticsResult, "30 days")}
        value={measureValueCompact(mrr.total, mrr.unit, mrr.currency)}
        title={money(mrr.total, mrr.currency ?? "USD")}
        stats={[
          only
            ? {
                label: "ARR",
                value:
                  arr?.total != null
                    ? measureValueCompact(arr.total, arr.unit, arr.currency)
                    : null,
                title: arr?.total != null ? money(arr.total, arr.currency ?? "USD") : undefined,
              }
            : {
                label: "Businesses",
                value: `${visible.length - dropped.size} of ${visible.length}`,
              },
          ...(only
            ? [
                {
                  label: "Committed",
                  value:
                    soleCmrr?.total != null
                      ? measureValueCompact(soleCmrr.total, soleCmrr.unit, soleCmrr.currency)
                      : null,
                  title:
                    soleCmrr?.total != null
                      ? money(soleCmrr.total, soleCmrr.currency ?? "USD")
                      : undefined,
                },
              ]
            : []),
          {
            label: "Cancelling",
            href: subsHref ? `${subsHref}?status=non_renewing` : undefined,
            value:
              cancelling > 0
                ? measureValueCompact(cancelling, "money", cancelResult?.currency ?? null)
                : null,
            title:
              cancelling > 0
                ? `${money(cancelling, cancelResult?.currency ?? "USD")} of MRR booked to cancel`
                : undefined,
          },
        ]}
      />
      {/* Customers are the paying unit — ARPC and churn divide by them; subscriptions are the
        detail beneath. Each business's customer is its own account, so the counts add. */}
      <Headline
        span={3}
        bare={!!only}
        label="Paying customers"
        info={explain(G.payingCustomers, only ? G.arpa : null, G.payingSubs, G.renewing)}
        change={seriesChange(payingCustomers as unknown as AnalyticsResult, "30 days", "count")}
        value={
          payingCustomers?.total != null
            ? measureValueCompact(payingCustomers.total, "count", null)
            : "—"
        }
        stats={[
          ...(only
            ? [
                {
                  label: "ARPC",
                  value:
                    soleArpa?.total != null
                      ? money(Math.round(soleArpa.total), soleArpa.currency ?? "USD")
                      : null,
                },
              ]
            : []),
          {
            label: "Paying subs",
            value: paying?.total != null ? paying.total.toLocaleString("en") : null,
            href: subsHref
              ? `${subsHref}?filter=status:in:active,non_renewing&filter=mrr:gt:0`
              : undefined,
          },
          {
            label: "Renewing",
            value: renewing?.total != null ? renewing.total.toLocaleString("en") : null,
            href: subsHref ? `${subsHref}?filter=status:is:active&filter=mrr:gt:0` : undefined,
          },
        ]}
      />
      {/* Customer churn does not add up across businesses, so with several the card leads
        with MRR churn, which does. */}
      <Headline
        span={3}
        bare={!!only}
        label={soleCustChurn ? "Churn, 30 days" : "MRR churn, 30 days"}
        info={
          soleCustChurn
            ? explain(G.customerChurn, G.churned, G.mrrChurnRate, G.mrrLost)
            : explain(G.mrrChurnRate, G.mrrLost)
        }
        value={
          soleCustChurn?.total != null
            ? pctFromBps(soleCustChurn.total, 1)
            : hMrrChurn?.total != null
              ? pctFromBps(hMrrChurn.total, 1)
              : "—"
        }
        stats={[
          ...(soleCustChurn
            ? [
                {
                  label: "Churned",
                  value:
                    soleCustChurn.total_basis === "window" && soleCustChurn.total_numerator != null
                      ? soleCustChurn.total_numerator.toLocaleString("en")
                      : null,
                },
                {
                  label: "MRR churn",
                  value: hMrrChurn?.total == null ? null : pctFromBps(hMrrChurn.total, 1),
                },
              ]
            : []),
          {
            label: "MRR lost",
            value: hChurned == null ? null : measureValueCompact(hChurned, "money", cur),
            title: hChurned == null ? undefined : money(hChurned, cur),
          },
        ]}
      />
      <Headline
        span={3}
        bare={!!only}
        label="Trial conversion, 30 days"
        info={explain(G.trialConversion, G.trialsConverted, G.trialsEnded, G.newMrr30)}
        value={hTrialConv == null ? "—" : pctFromBps(hTrialConv, 1)}
        stats={[
          {
            label: "Converted",
            value: hTrial.converted == null ? null : hTrial.converted.toLocaleString("en"),
          },
          {
            label: "Ended",
            value: hTrial.ended == null ? null : hTrial.ended.toLocaleString("en"),
          },
          {
            label: "New MRR",
            value: hMrrNew == null ? null : measureValueCompact(hMrrNew, "money", cur),
            title: hMrrNew == null ? undefined : money(hMrrNew, cur),
          },
        ]}
      />
    </>
  ) : null;

  return (
    <NavPendingProvider>
      <PageHeader
        title={org.name}
        description={`${visible.length} ${visible.length === 1 ? "business" : "businesses"}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SyncedBadge syncedAt={syncedAt} />
            {currencySwitcher}
            {only ? null : (
              <Button asChild variant="outline" size="sm">
                <Link href="/metrics">Compare businesses</Link>
              </Button>
            )}
            {createControl}
          </div>
        }
      />

      {deniedNotice}

      <PendingContent skeleton={<OrgHomeSkeleton />}>
        {batchError ? (
          <ErrorState
            title="We could not read the organization’s figures"
            description={<span className="font-mono text-xs">{batchError}</span>}
            className="mb-8"
          />
        ) : null}

        {/* No base currency set: the engine refuses a cross-currency total and names the
          currencies it CAN answer. Its sentence, its options — never a currency we picked. */}
        {mrrRefusal ? (
          <div className="mb-8">
            <CurrencyRefusal refusal={mrrRefusal} hrefFor={(c) => `/?currency=${c}`} />
          </div>
        ) : null}

        <Stack>
          {/* The way into a business, before any figure. */}
          {only && mrr && !dormant ? null : (
            <>
              <ZoneHeading zone="businesses" />
              <BusinessCards rows={rows} currency={reportingCurrency} allHref="#businesses" />
            </>
          )}

          {/* The portfolio, converted once — every figure from the same batch, so they
            reconcile. Performance figures are the 30-day window. */}
          {mrr && dormant ? (
            <Grid>
              <Block span={12}>
                {/* Businesses exist in this mode, but none has billed anyone: four em dashes in a
                  row read as a broken page. Say what is true and where the figures will come from. */}
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <span className="text-lg font-semibold">No live billing yet</span>
                  <p className="max-w-md text-sm text-muted-foreground">
                    {visible.length === 1
                      ? `${visible[0]!.name} has not charged a customer yet.`
                      : `None of these ${visible.length} businesses has charged a customer yet.`}{" "}
                    Revenue, subscriptions and cash appear here after the first live subscription.
                    To try your setup first, open a business and turn on Test mode.
                  </p>
                </div>
              </Block>
            </Grid>
          ) : mrr ? (
            <>
              {only ? (
                <BusinessPanel row={only}>{figures}</BusinessPanel>
              ) : (
                <>
                  <div className="mt-4">
                    <ZoneHeading zone="portfolio">
                      <ZoneMeta>All businesses combined</ZoneMeta>
                    </ZoneHeading>
                  </div>
                  <Grid>{figures}</Grid>
                </>
              )}
              <AttentionStrip items={attentionItems} />

              {/* Performance: the fixed 30-day window this page reads. */}
              <div className="mt-4">
                <ZoneHeading zone="performance">
                  <ZoneMeta>Last 30 days</ZoneMeta>
                </ZoneHeading>
              </div>
              <OrgPerformance
                batch={batch}
                mrr={mrr}
                currency={mrr.currency ?? reportingCurrency ?? "USD"}
                onlyBiz={only?.id ?? null}
              />
            </>
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

          {/* One business is already the panel above; a one-row roster would repeat it. */}
          {only ? null : (
            <div id="businesses" className="scroll-mt-6">
              <Grid>
                <BusinessRoster rows={rows} mode={mode} />
              </Grid>
            </div>
          )}

          {mrr ? <ConversionNote result={mrr} businesses={visible} /> : null}
        </Stack>
      </PendingContent>

      {visible.length === 0 && isManager ? (
        <div className="mt-4 flex justify-center">{createControl}</div>
      ) : null}
    </NavPendingProvider>
  );
}
