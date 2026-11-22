"use client";

import * as React from "react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import type { PortalCreditPackQuote } from "@/lib/portal-api";
import { portalBuyCreditsAction, portalQuoteCreditsAction } from "./credits-actions";

/**
 * "Buy" for one credit pack: opens the purchase checkout for the quantity selected. The
 * subtotal follows the quantity; tax, if any, shows on the checkout. With `allowCoupon`, the
 * buyer can enter a code and see the discount before the checkout opens.
 */
export function BuyCreditsForm({
  price,
  label,
  amountMinor,
  currency,
  allowCoupon = false,
}: {
  price: string;
  label: string;
  amountMinor: number;
  currency: string;
  allowCoupon?: boolean;
}) {
  const [qty, setQty] = React.useState(1);
  const [couponOpen, setCouponOpen] = React.useState(false);
  const [coupon, setCoupon] = React.useState("");
  const [quote, setQuote] = React.useState<PortalCreditPackQuote | null>(null);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);
  const [checking, startCheck] = React.useTransition();
  const valid = Number.isInteger(qty) && qty >= 1 && qty <= 100;

  const check = () =>
    startCheck(async () => {
      const r = await portalQuoteCreditsAction({ price, quantity: qty, coupon });
      setQuote(r.ok ? r.quote : null);
      setQuoteError(r.ok ? null : r.error);
    });

  return (
    <ActionForm
      action={portalBuyCreditsAction}
      onSuccess={(r) => {
        if (r.redirectTo) window.location.assign(r.redirectTo);
      }}
      className="flex flex-wrap items-center gap-2 sm:justify-end"
    >
      <input type="hidden" name="price" value={price} />
      {qty !== 1 && valid && !quote ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          Subtotal {money(amountMinor * qty, currency)}
        </span>
      ) : null}
      {allowCoupon && !couponOpen ? (
        <Button type="button" variant="link" size="sm" onClick={() => setCouponOpen(true)}>
          Add coupon code
        </Button>
      ) : null}
      <Input
        name="quantity"
        type="number"
        min={1}
        max={100}
        defaultValue={1}
        onChange={(e) => {
          setQty(Number(e.target.value));
          setQuote(null);
        }}
        aria-label={`Quantity of ${label}`}
        className="h-8 w-16 tabular-nums"
      />
      {/* Outline: several packs, and no one of them is the page's main action. */}
      <SubmitButton size="sm" variant="outline">
        Buy
      </SubmitButton>
      {allowCoupon && couponOpen ? (
        <CouponRow
          coupon={coupon}
          onCoupon={(v) => {
            setCoupon(v);
            setQuote(null);
            setQuoteError(null);
          }}
          onCheck={check}
          checking={checking}
          canCheck={valid && coupon.trim().length > 0}
          quote={quote}
          error={quoteError}
          label={label}
        />
      ) : null}
    </ActionForm>
  );
}

/** The code field, its Check button, and the discount the code gives. */
function CouponRow({
  coupon,
  onCoupon,
  onCheck,
  checking,
  canCheck,
  quote,
  error,
  label,
}: {
  coupon: string;
  onCoupon: (v: string) => void;
  onCheck: () => void;
  checking: boolean;
  canCheck: boolean;
  quote: PortalCreditPackQuote | null;
  error: string | null;
  label: string;
}) {
  // A refusal from Buy itself lands here too.
  const buyError = useFieldError("coupon");
  const shown = error ?? buyError ?? null;
  return (
    <div className="flex basis-full flex-col gap-1 sm:items-end">
      <div className="flex items-center gap-2">
        <Input
          name="coupon"
          value={coupon}
          onChange={(e) => onCoupon(e.target.value)}
          onKeyDown={(e) => {
            // Enter checks the code. Buy stays a click.
            if (e.key === "Enter") {
              e.preventDefault();
              if (canCheck) onCheck();
            }
          }}
          aria-label={`Coupon code for ${label}`}
          aria-invalid={shown ? true : undefined}
          autoComplete="off"
          className="h-8 w-40"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canCheck || checking}
          onClick={onCheck}
        >
          Check
        </Button>
      </div>
      {shown ? <p className="m-0 text-xs text-destructive">{shown}</p> : null}
      {quote && !shown ? (
        <p className="m-0 text-xs text-muted-foreground tabular-nums">
          {quote.discount_minor > 0
            ? `Discount −\u2060${money(quote.discount_minor, quote.currency)} · You pay ${money(quote.total_minor, quote.currency)}`
            : `This code gives no discount on this pack. You pay ${money(quote.total_minor, quote.currency)}`}
          {quote.tax_minor > 0 ? `, tax included` : ""}
        </p>
      ) : null}
    </div>
  );
}
