"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { RecordCard } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";
import { SubFormFrame, FooterFigure, ShortLabel } from "@/components/subscriptions/sub-form-frame";
import { SummaryCard } from "@/components/catalog/form-kit";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { money, fmtDate } from "@/lib/format";
import { useDisplayTz } from "@/components/business-tz";

/**
 * One drafted charge line, before the invoice exists. Mirrors what the API's
 * manual-invoice line accepts: either a catalog `price` or a typed
 * description+amount, plus the per-charge service period.
 */
export interface DraftCharge {
  /** Client-side key only — never sent. */
  key: string;
  description: string;
  amountMinor: number;
  quantity?: number;
  /** Catalog price public id, when picked rather than typed. */
  price?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export const chargeCount = (n: number) => `${n} charge${n === 1 ? "" : "s"}`;

/**
 * The page shared by `{customers,subscriptions}/<id>/{add_charge,add_charge_price}`:
 * a repeater of drafted charges that all post as ONE invoice (the API takes `lines[]`),
 * beside a live summary. Render the page's <form> around it.
 *
 * The credits note is accurate — `createManualInvoice` passes `applyCredit: true`.
 */
export function ChargeFrame({
  crumbs,
  title,
  description,
  cancelHref,
  currency,
  drafts,
  onRemove,
  addControl,
  emptyHint,
  before,
  after,
  summaryLead,
  summaryRows,
  submitLabel,
  pending,
  error,
}: {
  crumbs: Crumb[];
  title: string;
  description: React.ReactNode;
  cancelHref: string;
  currency: string;
  drafts: DraftCharge[];
  onRemove: (key: string) => void;
  /** The trigger that opens the add-modal, in the Charges card header. */
  addControl?: React.ReactNode;
  /** Shown inside the Charges card while it is empty. */
  emptyHint: React.ReactNode;
  /** Cards above Charges (the customer-scope currency). */
  before?: React.ReactNode;
  /** Cards below Charges (the subscription-scope invoicing choice). */
  after?: React.ReactNode;
  summaryLead: React.ReactNode;
  summaryRows: Array<{ label: React.ReactNode; value: React.ReactNode } | null | false>;
  submitLabel: string;
  pending?: boolean;
  error?: string | null;
}) {
  // Period boundaries are midnight in the BUSINESS zone; without it they render UTC.
  const tz = useDisplayTz();
  const total = drafts.reduce((s, d) => s + d.amountMinor, 0);
  const n = drafts.length;

  return (
    <SubFormFrame
      crumbs={crumbs}
      title={title}
      description={description}
      status={error ? <Alert tone="error">{error}</Alert> : null}
      cancelHref={cancelHref}
      footerNote={
        n === 0
          ? "Add at least one charge to continue"
          : `${chargeCount(n)} · ${money(total, currency)}`
      }
      footerFigure={<FooterFigure label="Subtotal" value={money(total, currency)} />}
      primary={
        <Button type="submit" disabled={pending || n === 0}>
          {pending ? "Saving…" : <ShortLabel full={submitLabel} short="Add" />}
        </Button>
      }
      aside={
        <SummaryCard
          lead={summaryLead}
          rows={summaryRows}
          note="Available credits and excess payments apply to this invoice automatically."
        />
      }
    >
      {before}

      <RecordCard
        title="Charges"
        meta={`${n} added`}
        actions={
          addControl ? <div className="font-medium text-primary">{addControl}</div> : undefined
        }
        flush
      >
        {n === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_2rem] gap-3 border-b px-5 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <span>Charge</span>
              <span className="text-right">Amount</span>
              <span aria-hidden />
            </div>
            {drafts.map((d) => (
              <div
                key={d.key}
                className="grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-3 border-b px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium wrap-break-word">{d.description}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {d.price ? (
                      <span className="font-mono wrap-anywhere">{d.price}</span>
                    ) : (
                      <span>Quick charge</span>
                    )}
                    {d.quantity && d.quantity > 1 ? <span>× {d.quantity}</span> : null}
                    {d.periodStart && d.periodEnd ? (
                      <span>
                        {fmtDate(d.periodStart, tz)} → {fmtDate(d.periodEnd, tz)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <span className="text-right text-sm font-medium tabular-nums">
                  {money(d.amountMinor, currency)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(d.key)}
                  aria-label={`Remove ${d.description}`}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <div className="grid grid-cols-[minmax(0,1fr)_auto_2rem] gap-3 bg-muted/50 px-5 py-3 text-sm">
              <span className="font-medium">Subtotal</span>
              <span className="text-right font-semibold tabular-nums">
                {money(total, currency)}
              </span>
              <span aria-hidden />
            </div>
          </div>
        )}
      </RecordCard>

      {after}

      {/* Drafts are client state, so every line posts as one JSON field. */}
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(drafts.map(({ key: _k, ...l }) => l))}
      />
    </SubFormFrame>
  );
}

/** The `+ Add …` trigger that opens the quick-charge modal. */
export function AddChargeTrigger({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 transition-colors hover:text-primary/80"
    >
      <Plus className="size-4" /> {label}
    </button>
  );
}
