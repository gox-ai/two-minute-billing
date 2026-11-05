import * as React from "react";
import { Chip } from "@/components/patterns/chip";
import { KeyValueGrid, type KeyValueRow } from "@/components/patterns/key-value-grid";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { paymentMarkKey } from "@/components/brand/payment-mark";
import { regionFlag, regionName } from "@/lib/countries";
import { money, fmtDate } from "@/lib/format";
import { avsCheckOf } from "@/lib/payment-method-avs";
import { cn } from "@/lib/utils";
import type { PaymentMethod } from "@/lib/api";

/**
 * ONE instrument, rendered identically everywhere an operator meets it.
 *
 * The customer page and the subscription page each grew their own version of this box —
 * different chrome, different chip system, and a different SET OF FACTS: the subscription
 * card gained the mandate rows later, so for a while the two screens disagreed about
 * whether the same card could be charged. Both now render this, so a fact added here
 * appears on both or on neither.
 *
 * Presentational and hook-free on purpose: the customer page is a client component (its
 * Refresh reloads payment methods) and the subscription page is a server component, so
 * this has to compile into both. `PaymentMethod` is a TYPE import — pulling the value
 * side of `@/lib/api` would drag `next/headers` into the browser bundle.
 */
export function PaymentMethodCard({
  pm,
  tz,
  note,
  actions,
  className,
}: {
  pm: PaymentMethod;
  tz: string | null;
  /** One quiet line under the heading for context the instrument itself cannot carry. */
  note?: React.ReactNode;
  /** Footer controls. Omitted entirely (no empty bar) when the caller has none. */
  actions?: React.ReactNode;
  className?: string;
}) {
  const hasMark = paymentMarkKey({ brand: pm.brand, type: pm.type, mandateRail: pm.mandate?.rail });
  const rows = paymentMethodRows(pm, tz).filter(Boolean) as KeyValueRow[];
  const mid = Math.ceil(rows.length / 2);
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground",
              hasMark ? "border bg-card" : "bg-muted",
            )}
          >
            <InstrumentMark
              brand={pm.brand}
              type={pm.type}
              // A UPI Autopay mandate has no card brand — the rail IS the instrument, and
              // without this it drew a generic card glyph on both screens.
              mandateRail={pm.mandate?.rail}
              last4={pm.last4}
              className={hasMark ? undefined : "size-4"}
            />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">
              <span className="capitalize">{pm.brand ?? pm.type}</span>
              {pm.last4 ? ` ending ${pm.last4}` : ""}
            </div>
            <div className="text-xs text-muted-foreground">via {pm.provider}</div>
            {note ? <div className="mt-0.5 text-xs text-muted-foreground">{note}</div> : null}
          </div>
        </div>
        {/* TWO roles, not three. `is_default` is `role === "primary"` (serialize.ts) and
            `setDefaultPaymentMethod` is a one-line alias for assigning `primary` — "default" is
            simply the pre-C6 name, kept on the API because integrators hold it. Rendering it
            beside "Primary" invented a third state: the chip was unreachable anyway
            (`is_default && role !== "primary"` is never true) and a "Set default" button sat
            next to "Make primary" posting the same thing. The buyer portal and checkout say
            `Primary` too as of 2026-09-14, so one role has exactly one word.
            The role is the CUSTOMER-level one, always. A subscription that overrides which
            instrument it charges says so in `note` — badging that card "Primary" would claim
            something about the customer's other subscriptions that is not true. */}
        <span className="inline-flex shrink-0 gap-1.5">
          {pm.role === "primary" ? (
            <Chip tone="blue" title="We charge this method first. The buyer portal also shows it.">
              Primary
            </Chip>
          ) : null}
          {pm.role === "backup" ? (
            <Chip title="We try this method when the primary fails, if it is a different card.">
              Backup
            </Chip>
          ) : null}
        </span>
      </div>
      {/* Two columns only once THIS BOX is wide enough. `KeyValueGrid columns={2}` splits
          on a viewport breakpoint, which cannot tell the two callers apart: the same card
          is ~550px wide inside the customer page's column and full width in the
          subscription section, and at 550px the split put the Reference ID on six lines. */}
      <div className="@container">
        <div className="grid @2xl:grid-cols-2 @2xl:gap-x-6 [&>*+*]:border-t @2xl:[&>*+*]:border-t-0">
          <KeyValueGrid rows={rows.slice(0, mid)} />
          <KeyValueGrid rows={rows.slice(mid)} />
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t px-4 py-2.5">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A capability row, or nothing at all when the gateway did not say — an unanswered
 * capability must not render as a "no". `warn` marks the case where the "no" needs a human.
 */
function capabilityRow(
  label: string,
  value: boolean | null | undefined,
  warn?: React.ReactNode,
): KeyValueRow | null {
  if (value == null) return null;
  if (value) return { label, value: "Supported" };
  return {
    label,
    value: (
      <span className={warn ? "text-destructive" : undefined}>
        Not supported
        {warn ? <span className="ml-1.5 text-xs font-normal">{warn}</span> : null}
      </span>
    ),
  };
}

/**
 * Every fact we hold about one instrument, in one order.
 *
 * A row is DROPPED when the value is unknown rather than printed as a dash — except
 * `Issuing country` on a card, which stays and says "Not reported". That one is not
 * cosmetic: RBI's e-mandate and AFA rules bind Indian-issued cards and the engine reads a
 * null as UNKNOWN, so an operator wondering why a renewal asks for authentication needs to
 * see that nobody has answered the question. `pnpm repair:pm-details` fills it in.
 */
export function paymentMethodRows(pm: PaymentMethod, tz: string | null): Array<KeyValueRow | null> {
  const inst = pm.instrument;
  // Card-shaped: a `last4` means a card even where the gateway's `type` is vague.
  const cardish = (pm.type ?? "").toLowerCase() === "card" || !!pm.last4;
  const country = inst?.issuer_country?.trim().toUpperCase() || null;
  const flag = regionFlag(country);

  return [
    { label: "Gateway", value: <span className="capitalize">{pm.provider}</span> },
    // The gateway ACCOUNT ("Razorpay-1"), not a `Type` row.
    // Omitted for legacy env-configured providers, which have no gateway_accounts row.
    pm.gateway_account_label ? { label: "Gateway account", value: pm.gateway_account_label } : null,
    // The GATEWAY's reference (`<gateway customer id>/<gateway token id>`), never our
    // `pm_…` — that is the row below. Null when the gateway gave us no token to name;
    // then the row is dropped rather than filled with an internal id.
    pm.reference_id
      ? {
          label: "Reference ID",
          value: <span className="font-mono text-xs break-all">{pm.reference_id}</span>,
          copy: pm.reference_id,
        }
      : null,
    /**
     * OUR id, next to the gateway's, because telling two of a customer's cards apart is
     * the question this card gets asked. Logs, `gateway_request_logs`, the collection
     * path and every support query name the instrument as `pm_…`, and until now the only
     * way to match one to a card on screen was the last four digits — which are not
     * unique: the same physical card is vaulted more than once on this book (that is why
     * `instrument_fingerprint` exists), so "····4242" can name several rows.
     *
     * Always present, unlike `reference_id`: a payment method has a public id from the
     * moment it is created, whether or not a gateway ever handed us a token.
     */
    {
      label: "Payment method ID",
      value: <span className="font-mono text-xs break-all">{pm.id}</span>,
      copy: pm.id,
    },
    pm.status
      ? {
          label: "Status",
          value: (
            <span className="capitalize">
              {pm.status}
              {/* `status` stays `valid` for a SPENT single-use mandate on purpose — the
                  charge pre-flight refuses it without branding the instrument, because it
                  did exactly what it was authorised to do, once. Unsaid, that reads as a
                  chargeable instrument that silently never charges again. */}
              {pm.mandate?.status?.toLowerCase() === "spent" ? (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground normal-case">
                  · the single-use mandate is spent. We cannot charge it again.
                </span>
              ) : null}
            </span>
          ),
        }
      : null,
    pm.exp_month && pm.exp_year
      ? {
          label: "Expiry date",
          value: `${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}`,
        }
      : cardish
        ? { label: "Expiry date", value: "—" }
        : null,
    inst?.funding
      ? { label: "Funding", value: <span className="capitalize">{inst.funding}</span> }
      : null,
    inst?.sub_type
      ? { label: "Holder type", value: <span className="capitalize">{inst.sub_type}</span> }
      : null,
    country || cardish
      ? {
          label: "Issuing country",
          value: country ? (
            <span>
              {flag ? <span className="mr-1.5">{flag}</span> : null}
              {regionName(country)}
              {regionName(country) === country ? null : (
                <span className="ml-1.5 text-xs text-muted-foreground">{country}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">Not reported</span>
          ),
        }
      : null,
    inst?.issuer_name ? { label: "Issuing bank", value: inst.issuer_name } : null,
    capabilityRow("3D Secure", inst?.three_d_secure_supported),
    capabilityRow("International use", inst?.supports_international),
    // An instrument that cannot do recurring, carrying a mandate, is a renewal that never
    // collects — the one capability whose "no" is an operator's problem today.
    capabilityRow(
      "Recurring debits",
      inst?.supports_recurring,
      pm.mandate ? "· A mandate on this instrument cannot collect payments." : null,
    ),
    // Stripe only: the same underlying card across customers and accounts. It is what
    // `usableBackup` compares, so "why was the backup skipped?" is answered here.
    inst?.fingerprint
      ? {
          label: "Fingerprint",
          value: <span className="font-mono text-xs break-all">{inst.fingerprint}</span>,
          copy: inst.fingerprint,
        }
      : null,
    // The MANDATE this instrument rides, when it rides one. The ceiling is enforced per
    // debit by the rail, so it decides whether a renewal can be collected at all.
    pm.mandate
      ? {
          label: "Mandate rail",
          value: <span className="capitalize">{pm.mandate.rail ?? "—"}</span>,
        }
      : null,
    pm.mandate
      ? {
          label: "Mandate status",
          value: <span className="capitalize">{pm.mandate.status ?? "unknown"}</span>,
        }
      : null,
    // Null = the gateway reported no ceiling. Say "not reported" rather than leave a blank
    // that reads as "no limit" — it is the opposite, and the charge pre-flight SKIPS its
    // check when the ceiling is unknown.
    pm.mandate
      ? {
          label: "Max per debit",
          value:
            pm.mandate.max_amount_minor != null ? (
              money(pm.mandate.max_amount_minor, pm.mandate.currency ?? "INR")
            ) : (
              <span className="text-muted-foreground">Not reported</span>
            ),
        }
      : null,
    pm.mandate?.expires_at
      ? { label: "Mandate expires", value: fmtDate(pm.mandate.expires_at, tz) }
      : null,
    // Gateway AVS/CVC verdict — diagnostic, one quiet line, and only when something was
    // actually captured. Stripe only today.
    (() => {
      const avs = avsCheckOf(pm);
      if (!avs) return null;
      const parts: string[] = [];
      if (avs.line1) parts.push(`Address ${avs.line1}`);
      if (avs.postal_code) parts.push(`ZIP ${avs.postal_code}`);
      if (avs.cvc) parts.push(`CVC ${avs.cvc}`);
      if (parts.length === 0) return null;
      return {
        label: "AVS / CVC",
        value: <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>,
      };
    })(),
  ];
}
