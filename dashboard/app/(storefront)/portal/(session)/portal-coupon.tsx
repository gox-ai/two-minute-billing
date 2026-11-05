"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { portalApplyCouponAction, portalRemoveCouponAction } from "./actions";

type Discount = { id: string; coupon: string | null; source: string; removable: boolean };

/**
 * Remove, rendered ON the discount line it refers to (see `portal-chrome`).
 *
 * The Next payment block already itemises the discount by name — "includes TMRSMARTCOACH
 * −$50.00" — so a footer repeating the code under it printed the same thing twice on one
 * card. The control belongs beside the figure it changes.
 *
 * Coupon-sourced discounts only. An operator's manual discount is not the buyer's to lift,
 * and the route refuses it with 403 regardless of what renders here.
 */
export function PortalCouponRemove({
  subscription,
  coupon,
}: {
  subscription: string;
  coupon: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setError(null);
    setBusy(true);
    const res = await portalRemoveCouponAction(subscription, coupon);
    setBusy(false);
    if (!res.ok) return setError(res.error ?? "We could not remove that discount.");
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        aria-label={`Remove coupon ${coupon}`}
        className="text-xs font-medium text-primary transition-colors hover:underline disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
      {/* Confirmed, because it is one-way from the buyer's side: we do not hand the code
          back, and the portal accepts one discount at a time, so a stray click costs them
          the discount until they find the code again. `brand` because Radix portals the
          dialog outside the storefront's `[data-brand]` wrapper. */}
      <ConfirmDialog
        brand
        destructive
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove this coupon?"
        description={
          <>
            We remove <span className="font-mono">{coupon}</span> from this plan. Your next payment
            returns to the full amount. To apply it again, you must enter the code again.
          </>
        }
        confirmLabel="Remove coupon"
        cancelLabel="Keep coupon"
        onConfirm={remove}
      />
    </>
  );
}

/**
 * The customer's coupon box on their own subscription (0238).
 *
 * Rendered only when `me.business.allow_customer_coupons` — the routes 403 otherwise, and a
 * box that refuses is worse than none.
 *
 * **As many codes as the business allows (0495), and the buyer can swap them.** At the cap
 * there is no "Have a coupon code?": the apply route refuses another code. What shows
 * instead is the code that IS applied, with Remove beside it, so a buyer who typed the wrong
 * code has a way back.
 *
 * **Remove is coupon-only.** An operator's manual discount reports `removable: false` and
 * renders without the control: the buyer never asked for it and could not put it back.
 * A merchant-granted COUPON can be taken off here, and the buyer needs the code to restore
 * it — stated rather than designed away, and a merchant who cannot accept that turns the
 * coupon box off.
 *
 * Refreshes rather than patching locally: a discount moves the next-payment total, which
 * only the server computes. Rendering "applied" next to an unchanged figure is the failure
 * mode worth avoiding.
 */
export function PortalCouponBox({
  subscription,
  discount,
  namedAbove = false,
  codesLeft = 0,
}: {
  subscription: string;
  discount: Discount | null;
  /** The Next payment estimate already itemises this discount by name. */
  namedAbove?: boolean;
  /** Codes the buyer can still enter (0495). Above 0 the box shows beside a live discount. */
  codesLeft?: number;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"apply" | null>(null);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setCode("");
    setError(null);
  }

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    const entered = code.trim();
    if (!entered || busy) return;
    setError(null);
    setBusy("apply");
    const res = await portalApplyCouponAction(subscription, entered);
    setBusy(null);
    if (!res.ok) {
      // Left in the field on failure, so a typo can be corrected rather than retyped.
      setError(res.error ?? "We could not apply that code.");
      return;
    }
    setCode("");
    setOpen(false);
    // The refresh is what swaps this box for the applied state — the server owns both the
    // new total above and the fact that a discount now exists.
    router.refresh();
  }

  if (discount && codesLeft <= 0) {
    // The Next payment line already names it and carries its own Remove — see
    // `PortalCouponRemove`. Repeating either here is the duplication this replaced.
    if (namedAbove) return null;
    // The fallback: a live discount with no line in the NEXT estimate (a `once` coupon
    // already consumed). Nothing above names it, so this row does — and it hands the
    // removal to the same confirmed control rather than a second, unconfirmed one.
    return (
      <div className="border-t px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">
            {discount.coupon ? (
              <>
                Coupon <span className="font-mono text-foreground">{discount.coupon}</span> applied
              </>
            ) : (
              "This plan has a discount"
            )}
          </span>
          {discount.removable && discount.coupon ? (
            <PortalCouponRemove subscription={subscription} coupon={discount.coupon} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t px-5 py-3">
      {open ? (
        <form onSubmit={apply} className="flex flex-wrap items-center gap-3">
          {/* Field and Apply are one control, not two objects sharing a row: the wrapper
              owns the border and the focus ring, and the Input inside surrenders both. */}
          <div className="flex h-9 w-full max-w-[17rem] items-stretch overflow-hidden rounded-md border border-input bg-card shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <Input
              ref={inputRef}
              id={`coupon-${subscription}`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
              }}
              placeholder="Enter your code"
              aria-label="Coupon code"
              spellCheck={false}
              autoComplete="off"
              maxLength={100}
              className="h-full rounded-none border-0 bg-transparent px-3 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0"
            />
            {/* `ghost`, not a fill: on a storefront route `--solid` becomes the merchant's raw
                brand colour (lib/brand.ts), and this is a secondary action. */}
            <Button
              type="submit"
              variant="ghost"
              disabled={!code.trim() || busy === "apply"}
              className="h-full rounded-none border-l border-input px-3 text-xs font-medium text-primary hover:bg-muted"
            >
              {busy === "apply" ? "Applying…" : "Apply"}
            </Button>
          </div>
          <button
            type="button"
            onClick={close}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Cancel
          </button>
        </form>
      ) : (
        /* Collapsed until asked for: most buyers have no code, and an empty field parked
           under their next payment reads as an unfinished form on a card that is
           otherwise a statement. */
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs font-medium text-primary transition-colors hover:underline"
        >
          Have a coupon code?
        </button>
      )}
      {error ? (
        <Alert tone="error" className="mt-2 text-xs">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
