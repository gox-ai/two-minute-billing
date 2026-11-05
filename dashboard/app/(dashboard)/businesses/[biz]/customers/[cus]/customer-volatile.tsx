"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import Link from "next/link";
import {
  CreditCard,
  Layers,
  CalendarClock,
  CircleDollarSign,
  FileText,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { PaymentMethodRow } from "@/components/payments/payment-method-row";
import { RefreshButton } from "@/components/refresh-button";
import { ActionButton } from "@/components/action-button";
import { AssignRoleButton } from "@/components/customers/customer-actions";
import { CollectInvoiceDialog } from "@/components/invoices/collect-invoice-dialog";
import { CustomerBalancesPanel } from "@/components/customers/customer-balances-panel";
import { ExcessPaymentsHeld } from "@/components/customers/excess-payments-held";
import { RequestUpdateButton } from "@/components/customers/request-update-button";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import {
  AttentionCard,
  FigureTile,
  FigureTiles,
  RecordCard,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { UnpaidJourneys } from "@/components/invoices/unpaid-journeys";
import { Pager, useLocalPages } from "@/components/patterns/pager";
import type { InvoiceTimeline } from "@/components/invoices/invoice-timeline";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "../../emails/actions";
import { createPortalLinkAction } from "./actions";
import { SecretLinkButton } from "@/components/patterns/secret-link-button";
import { detachPaymentMethodAction } from "@/app/actions";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import type { Invoice, PaymentMethod, Subscription, SubscriptionItem } from "@/lib/api";
import { refreshCustomerVolatileAction, type CustomerVolatileData } from "./refresh-action";

// ---------------------------------------------------------------------------
// Shared context: one refresh reloads balances, payment methods, and
// subscription+invoice state — the facts the buyer portal can move without
// the operator touching this screen. Everything else on the page (profile,
// addresses, custom fields, history, activity log) is untouched server HTML.
// ---------------------------------------------------------------------------

const Ctx = React.createContext<{
  data: CustomerVolatileData;
  refresh: () => void;
  pending: boolean;
} | null>(null);

function useVolatile(): CustomerVolatileData {
  const ctx = React.useContext(Ctx);
  if (!ctx)
    throw new Error("Customer volatile components must render inside CustomerRefreshProvider");
  return ctx.data;
}

export function CustomerRefreshProvider({
  biz,
  cus,
  initial,
  children,
}: {
  biz: string;
  cus: string;
  initial: CustomerVolatileData;
  children: React.ReactNode;
}) {
  // Re-seeded when a save re-renders the page; a bare useState kept the pre-save data.
  const [data, setData] = useDefaultState(initial, (v) => JSON.stringify(v));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const refresh = () => {
    startTransition(async () => {
      const res = await refreshCustomerVolatileAction(biz, cus);
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <Ctx.Provider value={{ data, refresh, pending }}>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {children}
    </Ctx.Provider>
  );
}

export function CustomerRefreshButton() {
  const ctx = React.useContext(Ctx);
  if (!ctx) return null;
  return <RefreshButton onRefresh={ctx.refresh} pending={ctx.pending} variant="outline" />;
}

// --- Derived facts ---------------------------------------------------------------

const OPEN = ["posted", "payment_due", "not_paid"];

function openInvoices(invoices: Invoice[]) {
  return invoices
    .filter((i) => OPEN.includes(i.status) && (i.amount_due_minor ?? i.total_minor) > 0)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

function dueByCurrency(invoices: Invoice[]) {
  const m = new Map<string, number>();
  for (const i of openInvoices(invoices)) {
    m.set(i.currency, (m.get(i.currency) ?? 0) + (i.amount_due_minor ?? i.total_minor));
  }
  return m;
}

const joinMoney = (entries: Iterable<[string, number]>) =>
  [...entries].map(([c, v]) => money(v, c)).join(" · ");

/** Renewing subscriptions, soonest first; a trial reports its trial end. */
function billable(subs: Subscription[]) {
  return subs
    .filter((s) => ["active", "in_trial"].includes(s.status) && !s.cancel_at_period_end)
    .sort(
      (a, b) =>
        (a.next_billing_at ? Date.parse(a.next_billing_at) : Infinity) -
        (b.next_billing_at ? Date.parse(b.next_billing_at) : Infinity),
    );
}

const planOf = (s: Subscription) =>
  s.items?.find((i) => i.product_kind === "plan") ?? s.items?.[0] ?? null;

const cardName = (pm: PaymentMethod) =>
  `${pm.brand ? pm.brand[0].toUpperCase() + pm.brand.slice(1) : (pm.type ?? "Card")}${
    pm.last4 ? ` ending ${pm.last4}` : ""
  }`;

const expiry = (pm: PaymentMethod) =>
  pm.exp_month && pm.exp_year ? `${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}` : null;

/** Whole days until the card stops working (the end of its expiry month). */
function daysToExpiry(pm: PaymentMethod): number | null {
  if (!pm.exp_month || !pm.exp_year) return null;
  return Math.ceil((Date.UTC(pm.exp_year, pm.exp_month, 1) - Date.now()) / 86_400_000);
}

// --- Header chip ------------------------------------------------------------------

export function CustomerDueChip() {
  const { invoices } = useVolatile();
  const due = dueByCurrency(invoices);
  return due.size ? <Chip tone="red">{joinMoney(due)} due</Chip> : null;
}

// --- Needs attention --------------------------------------------------------------

export function CustomerAttention({
  biz,
  tz,
  tracks,
}: {
  biz: string;
  tz: string | null;
  /** The unpaid invoices' payments and dunning (read on the server, 1–2 only). */
  tracks: InvoiceTimeline[];
}) {
  const { customer, invoices, pms, subs } = useVolatile();
  const items: AttentionItem[] = [];

  const open = openInvoices(invoices);
  const due = dueByCurrency(invoices);
  if (open.length) {
    const oldest = open[0];
    const single = open.length === 1;
    items.push({
      key: "due",
      tone: "attention",
      title: `${open.length} unpaid invoice${single ? "" : "s"} · ${joinMoney(due)}`,
      // One invoice: its own number, attempts and retry. Several: only the oldest date —
      // one invoice's attempts beside another's retry date would describe neither.
      detail: single
        ? [
            `Invoice ${oldest.number ?? oldest.id}`,
            oldest.created_at ? `since ${fmtDate(oldest.created_at, tz)}` : null,
            oldest.attempt_count
              ? `${oldest.attempt_count} attempt${oldest.attempt_count === 1 ? "" : "s"}`
              : null,
            oldest.next_attempt_at
              ? `${customer.auto_collection === "off" ? "next reminder" : "next retry"} ${fmtDateTime(oldest.next_attempt_at, tz)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : oldest.created_at
          ? `Oldest due since ${fmtDate(oldest.created_at, tz)}`
          : undefined,
      actions: (
        <>
          {single ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/businesses/${biz}/invoices/${oldest.id}`}>View invoice</Link>
            </Button>
          ) : (
            <Button asChild variant="outline" size="sm">
              <a href="#history">View invoices</a>
            </Button>
          )}
          {/* One invoice only — its own collect (a manual attempt, card choice). With
              several, the operator picks which to collect under More. */}
          {single ? (
            <CollectInvoiceDialog
              biz={biz}
              invoice={{
                id: oldest.id,
                number: oldest.number ?? null,
                dueMinor: oldest.amount_due_minor ?? oldest.total_minor,
                currency: oldest.currency,
              }}
              pms={pms}
              back={`/businesses/${biz}/customers/${customer.id}`}
            />
          ) : null}
        </>
      ),
    });
  }

  const primary = pms.find((p) => p.role === "primary") ?? null;
  const days = primary ? daysToExpiry(primary) : null;
  const collects =
    customer.auto_collection !== "off" &&
    subs.some((s) => ["active", "in_trial", "non_renewing"].includes(s.status));
  if (primary && days != null && days <= 30) {
    items.push({
      key: "card",
      tone: days <= 0 ? "attention" : "warning",
      title:
        days <= 0
          ? `Primary card expired ${expiry(primary)}`
          : `Primary card expires ${expiry(primary)}`,
      detail: `${cardName(primary)} · the customer replaces it in their portal`,
      actions: <RequestUpdateButton biz={biz} customer={customer.id} email={customer.email} />,
    });
  } else if (!primary && collects) {
    items.push({
      key: "card",
      tone: "warning",
      title: "No payment method on file",
      detail: "Renewals collect automatically, but there is no payment method to charge",
      actions: (
        <RequestUpdateButton
          biz={biz}
          customer={customer.id}
          email={customer.email}
          label="Request a card"
        />
      ),
    });
  }

  return (
    <AttentionCard items={items}>
      {/* Only while the count the timelines were built for still holds (Refresh can move it). */}
      {open.length && open.length === tracks.length ? (
        <UnpaidJourneys biz={biz} tz={tz} tracks={tracks} />
      ) : null}
    </AttentionCard>
  );
}

// --- Figures ------------------------------------------------------------------------

export function CustomerFigures({
  biz,
  tz,
  txnCurrencyFallback,
}: {
  biz: string;
  tz: string | null;
  txnCurrencyFallback: string;
}) {
  const { customer, subs, invoices, renewalEstimates } = useVolatile();
  const txnCurrency = customer.effective_currency ?? customer.currency ?? txnCurrencyFallback;
  const due = dueByCurrency(invoices);
  const open = openInvoices(invoices).length;
  const mrr = Object.entries(customer.mrr ?? {}).filter(([, v]) => v > 0);
  const next = billable(subs)[0];
  const nextAmount = next ? renewalEstimates[next.id]?.total_minor : undefined;
  const refundable =
    customer.balances?.find((b) => b.currency_code === txnCurrency)?.refundable_credits ?? 0;
  const revenue = customer.lifetime_revenue ?? [];
  const mainRevenue = revenue.find((r) => r.currency === txnCurrency) ?? revenue[0];
  const otherRevenue = revenue.filter((r) => r !== mainRevenue);
  const credit = refundable > 0 ? `${money(refundable, txnCurrency)} refundable credit` : null;

  return (
    <FigureTiles>
      <FigureTile
        label="Total due"
        icon={FileText}
        value={due.size ? joinMoney(due) : money(0, txnCurrency)}
        note={[
          open ? `${open} open invoice${open === 1 ? "" : "s"}` : "Nothing outstanding",
          credit,
        ]
          .filter(Boolean)
          .join(" · ")}
        tone={due.size ? "loss" : undefined}
      />
      <FigureTile
        label="MRR"
        icon={CircleDollarSign}
        value={mrr.length ? money(mrr[0][1], mrr[0][0]) : "—"}
        note={mrr.length > 1 ? `+ ${joinMoney(mrr.slice(1))}` : undefined}
      />
      <FigureTile
        label="Upcoming payment"
        icon={CalendarClock}
        value={next && nextAmount != null ? money(nextAmount, next.currency) : "—"}
        note={
          next?.next_billing_at
            ? `${fmtDate(next.next_billing_at, tz)} · ${planOf(next)?.product_name ?? next.id}`
            : "No upcoming payment"
        }
        href={next ? `/businesses/${biz}/subscriptions/${next.id}?from=customer` : undefined}
      />
      <FigureTile
        label="Lifetime revenue"
        icon={TrendingUp}
        featured
        value={money(mainRevenue?.amount_minor ?? 0, mainRevenue?.currency ?? txnCurrency)}
        note={
          otherRevenue.length
            ? `+ ${joinMoney(otherRevenue.map((r): [string, number] => [r.currency, r.amount_minor]))}`
            : mainRevenue?.first_paid_at
              ? `Paid since ${fmtDate(mainRevenue.first_paid_at, tz)} · net of refunds`
              : "Nothing collected yet"
        }
      />
    </FigureTiles>
  );
}

// --- Subscriptions ----------------------------------------------------------------

export function CustomerSubscriptionsCard({
  biz,
  cus,
  tz,
  priceToProduct,
  productInfo,
}: {
  biz: string;
  cus: string;
  tz: string | null;
  /** Static catalog lookups — price/product/group never change from a refresh. */
  priceToProduct: Record<string, string | undefined>;
  productInfo: Record<string, { name: string; group: string | null } | undefined>;
}) {
  const { subs, renewalEstimates } = useVolatile();
  const [showEnded, setShowEnded] = React.useState(false);
  const live = subs.filter((s) => s.status !== "cancelled");
  const ended = subs.filter((s) => s.status === "cancelled");
  // Nothing live: the cancelled rows ARE the history, so show them rather than an empty table.
  const allEnded = live.length === 0;
  const page = useLocalPages(showEnded || allEnded ? [...live, ...ended] : live, 10);
  const groupOf = (i: SubscriptionItem | null) =>
    i ? (productInfo[priceToProduct[i.price] ?? ""]?.group ?? null) : null;

  const row = (s: Subscription) => {
    const plan = planOf(s);
    const addons = (s.items ?? []).filter((i) => i !== plan);
    const est = renewalEstimates[s.id]?.total_minor;
    const extra = [
      groupOf(plan),
      addons.length ? `+ ${addons.map((a) => a.product_name ?? a.price).join(", ")}` : null,
    ].filter(Boolean);
    return (
      <TableRow key={s.id}>
        {/* Wraps rather than widening the table: catalogue names and add-on lists are
            long, and a detail table must never scroll sideways. */}
        <TableCell className="py-2.5 pl-5 whitespace-normal">
          <Link
            href={`/businesses/${biz}/subscriptions/${s.id}?from=customer`}
            className="font-medium wrap-anywhere text-primary hover:underline"
          >
            {plan?.product_name ?? plan?.price ?? s.id}
          </Link>
          {extra.length ? (
            <div className="text-xs wrap-anywhere text-muted-foreground">{extra.join(" · ")}</div>
          ) : null}
          <div className="font-mono text-xs wrap-anywhere text-muted-foreground">{s.id}</div>
        </TableCell>
        <TableCell>
          <StatusChip status={s.status} />
        </TableCell>
        <TableCell>
          {plan ? (
            <>
              <span>{money(plan.unit_price_minor ?? 0, s.currency)}</span>
              {(plan.quantity ?? 1) > 1 ? ` × ${plan.quantity}` : ""}
              {plan.interval ? (
                <span className="text-muted-foreground"> / {plan.interval}</span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="text-right">
          {s.mrr != null ? money(s.mrr, s.currency) : "—"}
        </TableCell>
        <TableCell>
          {s.status === "cancelled" ? (
            <div className="text-muted-foreground">
              <div>Cancelled</div>
              {s.canceled_at ? <div className="text-xs">{fmtDate(s.canceled_at, tz)}</div> : null}
            </div>
          ) : s.status === "in_trial" && s.trial_end ? (
            <>
              <div>Trial ends {fmtDate(s.trial_end, tz)}</div>
              {est != null ? (
                <div className="text-xs text-muted-foreground">{money(est, s.currency)}</div>
              ) : null}
            </>
          ) : s.next_billing_at ? (
            <>
              <div>{fmtDate(s.next_billing_at, tz)}</div>
              {est != null ? (
                <div className="text-xs text-muted-foreground">{money(est, s.currency)}</div>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="pr-5">{s.auto_collection === "off" ? "Off" : "Auto"}</TableCell>
      </TableRow>
    );
  };

  const head = (
    <TableHeader>
      <TableRow>
        <TableHead className="pl-5">Subscription</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Plan amount</TableHead>
        <TableHead className="text-right">MRR</TableHead>
        <TableHead>Next billing</TableHead>
        <TableHead className="pr-5">Collection</TableHead>
      </TableRow>
    </TableHeader>
  );

  return (
    <RecordCard
      id="subscriptions"
      title="Subscriptions"
      meta={
        subs.length ? (
          <span className="inline-flex items-center gap-1.5">
            <Chip tone={live.length ? "green" : "gray"}>{live.length} active</Chip>
            {ended.length ? <Chip tone="gray">{ended.length} cancelled</Chip> : null}
          </span>
        ) : undefined
      }
      actions={
        <Link
          href={`/businesses/${biz}/subscriptions/new?customer=${cus}`}
          className="text-primary hover:underline"
        >
          New subscription
        </Link>
      }
      flush
    >
      {subs.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<Layers />}
            title="No subscriptions"
            description="This customer has no subscriptions yet."
          />
        </div>
      ) : (
        <>
          {/* ONE fixed-layout table: widths come from the colgroup, never from the rows,
              so showing cancelled rows adds height without moving a column. */}
          <Table className="table-fixed max-lg:min-w-3xl">
            <colgroup>
              {/* At the 684px card (1024 viewport) a date and "non renewing" still fit whole. */}
              <col className="w-[19.5%]" />
              <col className="w-[19%]" />
              <col className="w-[14%]" />
              <col className="w-[14%]" />
              <col className="w-[18.5%]" />
              <col className="w-[15%]" />
            </colgroup>
            {head}
            <TableBody>{page.rows.map(row)}</TableBody>
          </Table>
          <Pager pager={page.pager} />
          {ended.length && !allEnded ? (
            <button
              type="button"
              aria-expanded={showEnded}
              onClick={() => setShowEnded((v) => !v)}
              className="w-full border-t px-5 py-3 text-left text-sm text-primary hover:underline"
            >
              {showEnded ? "Hide cancelled" : `Show ${ended.length} cancelled`}
            </button>
          ) : null}
        </>
      )}
    </RecordCard>
  );
}

// --- Payment methods --------------------------------------------------------------

const rank = (role: PaymentMethod["role"]) => (role === "primary" ? 0 : role === "backup" ? 1 : 2);

/**
 * Operators never add a card: the customer adds or replaces one in their portal
 * ("Request update" emails the link). What an operator decides here is which card
 * is charged first (primary) and which are tried after it (backup).
 */
export function CustomerPaymentMethodsCard({
  biz,
  cus,
  tz,
}: {
  biz: string;
  cus: string;
  tz: string | null;
}) {
  const { customer, pms } = useVolatile();
  const ordered = [...pms].sort(
    (a, b) => rank(a.role) - rank(b.role) || (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  const page = useLocalPages(ordered, 5);

  return (
    <RecordCard
      id="payment-methods"
      title="Payment methods"
      actions={
        <>
          <SecretLinkButton variant="link" mint={() => createPortalLinkAction(biz, cus)}>
            Portal link
          </SecretLinkButton>
          <RequestUpdateButton biz={biz} customer={cus} email={customer.email} variant="link" />
        </>
      }
      footer={
        pms.length ? (
          <span className="text-xs text-muted-foreground">
            The primary card is charged first; if it declines, each backup is tried in turn (up to
            two). Customers add cards in their portal.
          </span>
        ) : undefined
      }
    >
      {pms.length === 0 ? (
        <EmptyState
          icon={<CreditCard />}
          title="No payment methods"
          description="The customer adds a card from their portal."
        />
      ) : (
        <>
          <ul className="-my-2 divide-y">
            {page.rows.map((pm) => (
              <CustomerPaymentMethodRow
                key={pm.id}
                biz={biz}
                cus={cus}
                tz={tz}
                pm={pm}
                email={customer.email}
              />
            ))}
          </ul>
          <Pager pager={page.pager} className="-mx-5 mt-2 -mb-4" />
        </>
      )}
    </RecordCard>
  );
}

function CustomerPaymentMethodRow({
  biz,
  cus,
  tz,
  pm,
  email,
}: {
  biz: string;
  cus: string;
  tz: string | null;
  pm: PaymentMethod;
  email: string | null;
}) {
  return (
    <PaymentMethodRow
      pm={pm}
      tz={tz}
      primaryAction={
        pm.role !== "primary" ? (
          <AssignRoleButton biz={biz} cus={cus} pm={pm.id} role="primary" label="Make primary" />
        ) : null
      }
      menu={
        <>
          {pm.role === "backup" ? (
            <AssignRoleButton biz={biz} cus={cus} pm={pm.id} role="none" label="Remove backup" />
          ) : pm.role !== "primary" ? (
            <AssignRoleButton biz={biz} cus={cus} pm={pm.id} role="backup" label="Make backup" />
          ) : null}
          {pm.mandate?.rail && email ? (
            <SendEmailDialog
              types={ADHOC_TYPES_FOR.customer}
              defaultTo={email}
              recordLabel={`Re-authorize the ${pm.mandate.rail} mandate`}
              onSend={({ type, to, note }) =>
                sendAdhocEmailAction(biz, { type, customer: cus, to, note: note || undefined })
              }
              trigger={<button type="button">Ask to re-authorize</button>}
            />
          ) : null}
          <ActionButton
            resultAction={detachPaymentMethodAction}
            fields={{ biz, cus, pm: pm.id }}
            label="Remove"
            variant="ghost"
            size="sm"
            className="text-destructive"
            confirm={{
              title: "Remove payment method?",
              description:
                "We remove the payment method from this customer. We also clear its links to payments and subscriptions. You cannot undo this.",
              confirmLabel: "Remove",
              destructive: true,
            }}
          />
        </>
      }
    />
  );
}

// --- Balances & credits -----------------------------------------------------------

export function CustomerBalancesCard({
  biz,
  txnCurrencyFallback,
  refundReasonRequired = false,
}: {
  biz: string;
  txnCurrencyFallback: string;
  /** `required_reasons.refund`. */
  refundReasonRequired?: boolean;
}) {
  const { customer, excessPayments } = useVolatile();
  // The provider seeds once; a refund must re-read the balances and this list itself.
  const refresh = React.useContext(Ctx)?.refresh;
  const txnCurrency = customer.effective_currency ?? customer.currency ?? txnCurrencyFallback;
  return (
    <RecordCard id="balances" title="Balances & credits">
      <div className="space-y-4">
        <CustomerBalancesPanel biz={biz} customer={customer} defaultCurrency={txnCurrency} />
        <ExcessPaymentsHeld
          biz={biz}
          cus={customer.id}
          rows={excessPayments ?? []}
          onRefunded={refresh}
          reasonRequired={refundReasonRequired}
        />
      </div>
    </RecordCard>
  );
}
