import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { DunningJourneyView } from "./dunning-journey-view";
import type { InvoiceTimeline } from "./invoice-timeline";

/**
 * The unpaid invoices' payments and dunning inside a needs-attention card, in the invoice
 * page's own rows: one invoice shows its latest entries and what happens next; two open on
 * request, one each; more than two show none (the page points at the invoice list instead).
 * Customer and subscription pages both use it.
 */
export function UnpaidJourneys({
  biz,
  tz,
  tracks,
}: {
  biz: string;
  tz: string | null;
  tracks: InvoiceTimeline[];
}) {
  const body = (t: InvoiceTimeline) =>
    t.journey ? (
      <DunningJourneyView
        journey={t.journey}
        transactions={t.transactions}
        biz={biz}
        tz={tz}
        compact={{ href: `/businesses/${biz}/invoices/${t.invoice}` }}
      />
    ) : null;
  if (tracks.length === 1) {
    const b = body(tracks[0]);
    return b ? <div className="px-5 py-4">{b}</div> : null;
  }
  if (tracks.length === 2) {
    return (
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 px-5 py-3 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          Payments and dunning, per invoice
          <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="divide-y border-t">
          {tracks.map((t) => (
            <div key={t.invoice} className="space-y-3 px-5 py-4">
              <p className="text-sm font-medium">
                <Link
                  href={`/businesses/${biz}/invoices/${t.invoice}`}
                  className="text-primary hover:underline"
                >
                  Invoice {t.number}
                </Link>
                <span className="font-normal text-muted-foreground"> · {t.due} due</span>
              </p>
              {body(t)}
            </div>
          ))}
        </div>
      </details>
    );
  }
  return null;
}
