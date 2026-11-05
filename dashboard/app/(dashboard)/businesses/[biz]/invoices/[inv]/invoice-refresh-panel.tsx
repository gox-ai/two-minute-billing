"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { RefreshButton } from "@/components/refresh-button";
import { StatusChip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import type { PaymentMethod } from "@/lib/api";
import { AttentionCard, type AttentionItem } from "@/components/patterns/record-page";
import { CollectInvoiceDialog } from "@/components/invoices/collect-invoice-dialog";
import {
  CloseInvoiceButton,
  RegenerateInvoiceButton,
} from "@/components/invoices/invoice-lifecycle-actions";
import { PaymentsAndCreditsView } from "@/components/invoices/payments-and-credits-view";
import { refreshInvoiceVolatileAction, type InvoiceVolatileData } from "./refresh-action";
import { computeAmounts } from "./invoice-volatile";

/**
 * Holds the invoice's volatile state (status, amounts, payments, dunning) so the
 * Refresh control can reload just that — never `router.refresh()`, which would
 * re-run the page's five engine calls (invoice, credit notes, subscription,
 * customer, businesses) for one status check.
 */
interface Ctx {
  data: InvoiceVolatileData;
  pending: boolean;
  refresh: () => void;
}
const InvoiceVolatileContext = React.createContext<Ctx | null>(null);

function useInvoiceVolatile(): Ctx {
  const ctx = React.useContext(InvoiceVolatileContext);
  if (!ctx) throw new Error("Must be rendered under InvoiceVolatileProvider");
  return ctx;
}

export function InvoiceVolatileProvider({
  biz,
  invId,
  initial,
  children,
}: {
  biz: string;
  invId: string;
  initial: InvoiceVolatileData;
  children: React.ReactNode;
}) {
  // Re-seeds when the server re-renders with new data (an action's refresh).
  const [data, setData] = useDefaultState(initial, (v) => JSON.stringify(v));
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    startTransition(async () => {
      const res = await refreshInvoiceVolatileAction(biz, invId);
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [biz, invId, setData]);

  const value = React.useMemo(() => ({ data, pending, refresh }), [data, pending, refresh]);

  return (
    <InvoiceVolatileContext.Provider value={value}>
      {error ? (
        <Alert tone="error" className="mb-4">
          We could not refresh the invoice: {error}
        </Alert>
      ) : null}
      {children}
    </InvoiceVolatileContext.Provider>
  );
}

export function InvoiceRefreshButton() {
  const { pending, refresh } = useInvoiceVolatile();
  return <RefreshButton onRefresh={refresh} pending={pending} variant="ghost" />;
}

export function InvoiceStatusChips({ archival }: { archival: boolean }) {
  const { data } = useInvoiceVolatile();
  return (
    <>
      <StatusChip status={archival ? "imported" : data.status} />
      {data.written_off ? <StatusChip status="written_off" /> : null}
    </>
  );
}

export function InvoiceAmountDueValue({ currency, open }: { currency: string; open: boolean }) {
  const { data } = useInvoiceVolatile();
  const { amountDue } = computeAmounts(data, open);
  return <strong className="tabular-nums">{money(amountDue, currency)}</strong>;
}

/** The volatile tail of the totals ladder: withholding, credits applied, amount paid, amount due. */
export function InvoiceAmountLadderTail({
  currency,
  open,
  grantPostTaxMinor = 0,
}: {
  currency: string;
  open: boolean;
  /** Credit grants taxed at use: fixed at finalisation, and inside `credits_applied_minor`. */
  grantPostTaxMinor?: number;
}) {
  const { data } = useInvoiceVolatile();
  const { amountDue, amountPaid } = computeAmounts(data, open);
  const bucketCredits = (data.credits_applied_minor ?? 0) - grantPostTaxMinor;
  return (
    <>
      {data.withholding_minor ? (
        <div className="flex justify-between gap-8">
          <span className="text-muted-foreground">Tax withheld (TDS)</span>
          <span className="tabular-nums">−{money(data.withholding_minor, currency)}</span>
        </div>
      ) : null}
      {grantPostTaxMinor > 0 ? (
        <div className="flex justify-between gap-8">
          <span className="text-muted-foreground">Credit grants, after tax</span>
          <span className="text-success tabular-nums">−{money(grantPostTaxMinor, currency)}</span>
        </div>
      ) : null}
      {bucketCredits > 0 ? (
        <div className="flex justify-between gap-8">
          <span className="text-muted-foreground">Credits applied</span>
          <span className="text-success tabular-nums">−{money(bucketCredits, currency)}</span>
        </div>
      ) : null}
      {amountPaid > 0 ? (
        <div className="flex justify-between gap-8">
          <span className="text-muted-foreground">Amount paid</span>
          <span className="font-semibold text-success tabular-nums">
            −{money(amountPaid, currency)}
          </span>
        </div>
      ) : null}
      {open ? (
        <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
          <span>Amount due</span>
          <span className="tabular-nums">{money(amountDue, currency)}</span>
        </div>
      ) : null}
    </>
  );
}

export function PaymentsAndCreditsClient({
  biz,
  tz,
  open,
  currency,
  dunningActions,
}: {
  biz: string;
  tz: string | null;
  /** The invoice still has an amount due (the page's capabilities). */
  open: boolean;
  currency: string;
  /** Pause / Stop dunning, shown on the card header while dunning runs. */
  dunningActions?: React.ReactNode;
}) {
  const { data } = useInvoiceVolatile();
  // Without the transactions the timeline would silently drop refunds; show neither —
  // but keep Pause / Stop dunning reachable, since the card was their only home.
  if (data.paymentsUnavailable)
    return data.status === "payment_due" && dunningActions ? (
      <div className="flex flex-wrap gap-2">{dunningActions}</div>
    ) : null;
  const { amountDue } = computeAmounts(data, open);
  const owed = data.status === "payment_due" || data.status === "not_paid";
  return (
    <PaymentsAndCreditsView
      biz={biz}
      tz={tz}
      transactions={data.transactions}
      openIntents={data.openIntents}
      journey={data.journey}
      layout="card"
      // Dunning state only matters while money is still owed.
      dunningStatus={owed ? data.dunning_status : null}
      summary={{ amountDueMinor: amountDue, currency, owed }}
      actions={data.status === "payment_due" ? dunningActions : undefined}
    />
  );
}

/**
 * What the invoice needs now, each state with its next step. `can*` come from the page's initial
 * capabilities (like the More menu); the status gates follow Refresh.
 */
export function InvoiceAttention({
  biz,
  tz,
  invoice,
  open,
  canClose,
  canCollect,
  canRegenerate,
  pms,
  firstTried,
}: {
  biz: string;
  tz: string | null;
  invoice: {
    id: string;
    number: string | null;
    created_at: string | null;
    due_date: string | null;
    currency: string;
  };
  open: boolean;
  canClose: boolean;
  canCollect: boolean;
  canRegenerate: boolean;
  pms: PaymentMethod[];
  firstTried: PaymentMethod | null;
}) {
  const { data } = useInvoiceVolatile();
  const { amountDue } = computeAmounts(data, open);
  const cur = invoice.currency;
  // In dunning or past it. A `posted` invoice is not due yet: its Collect is in More.
  const owed = data.status === "payment_due" || data.status === "not_paid";
  const items: AttentionItem[] = [];

  if (canClose && data.status === "pending") {
    items.push({
      key: "pending",
      tone: "warning",
      title: "Pending invoice",
      detail:
        "Usage and charges are still accruing for this period. Close the invoice to finalize it. We then apply discounts, tax and credits and try to collect payment.",
      actions: (
        <CloseInvoiceButton
          biz={biz}
          inv={invoice.id}
          label="Close invoice"
          variant="outline"
          className=""
        />
      ),
    });
  }
  // A live attempt takes the collect control away, so this replaces the "due" row:
  // the operator still needs the balance and why Collect is gone.
  if (owed && data.payment_in_flight) {
    items.push({
      key: "in-flight",
      tone: "warning",
      title: "A payment is already in progress",
      detail: (
        <>
          {money(amountDue, cur)} {cur} is due. The gateway accepted a debit for it, but the debit
          has not settled.
          {data.awaiting_authentication
            ? " The customer must approve it with their bank before money can move." +
              " Their bank sends that request, and we cannot send it again. The request stays valid for 72 hours." +
              " If they do not act by then, the clock fails it and the invoice enters dunning with a" +
              " deadline. You cannot collect again until that happens, or until the CUSTOMER releases" +
              " it from their billing portal. That is the only way to pay this invoice sooner."
            : " You cannot collect again until it settles or fails. This rail can take up to two working days."}
        </>
      ),
    });
  } else if (owed && canCollect) {
    items.push({
      key: "due",
      tone: "attention",
      title: `${money(amountDue, cur)} ${cur} is due on this invoice`,
      detail: [
        invoice.due_date ? `Due ${fmtDate(invoice.due_date, tz)}` : null,
        data.status === "payment_due" && data.next_attempt_at
          ? `next automatic retry ${fmtDateTime(data.next_attempt_at, tz)}`
          : null,
        data.status === "not_paid"
          ? "automated dunning ended. Collect manually, record a payment or credit it"
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      actions: (
        <CollectInvoiceDialog
          biz={biz}
          invoice={{ id: invoice.id, number: invoice.number, dueMinor: amountDue, currency: cur }}
          pms={pms}
          firstTried={firstTried}
        />
      ),
    });
  }
  if (canRegenerate && data.status === "voided") {
    items.push({
      key: "voided",
      tone: "warning",
      title: "This invoice is voided.",
      detail:
        "You can regenerate a new invoice for the same billing period. It uses the current state of the subscription.",
      actions: (
        <RegenerateInvoiceButton
          biz={biz}
          inv={invoice.id}
          label="Regenerate"
          variant="outline"
          className=""
        />
      ),
    });
  }

  return (
    // The payments timeline lives only in the Payments card, which leads the page while
    // money is owed; this card keeps what is due and the step to collect it.
    <AttentionCard items={items} columns={false} />
  );
}
