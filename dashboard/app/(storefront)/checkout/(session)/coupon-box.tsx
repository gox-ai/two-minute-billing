"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { checkoutApplyCouponAction, checkoutRemoveCouponAction } from "./actions";

/**
 * The buyer's coupon box on the hosted checkout (0238).
 *
 * Rendered only when `view.allow_coupons` — the merchant's
 * `businesses.allow_customer_coupons`. The routes behind it 403 when that is off, so a box
 * shown regardless would be a control that refuses.
 *
 * **Why it refreshes instead of using what the action returned.** A discount does not only
 * change a chip: it moves the recurring total, and on a change link the whole proration
 * preview. Only the server computes those, so this posts and then `router.refresh()`es, and
 * the page re-renders from one source of truth. Patching the chips locally while the totals
 * beside them came from the previous render is exactly the parity-that-lies failure — the
 * buyer would read a discount that the amount underneath it did not include.
 *
 * The engine's own sentence is shown verbatim on failure ("No such coupon: FOO"). A buyer
 * has no operator to ask and no log to read; "could not apply" would leave them stuck.
 */
export function CouponBox({
  applied,
  refusals,
}: {
  applied: string[];
  refusals: Record<string, string>;
}) {
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    const entered = code.trim();
    if (!entered || busy) return;
    setError(null);
    setBusy("apply");
    const res = await checkoutApplyCouponAction(entered);
    if (!res.ok) {
      setError(res.error ?? "We could not apply that code.");
      setBusy(null);
      return;
    }
    // Cleared only on success, so a rejected code stays in the field to be corrected
    // rather than making the buyer retype it to find their typo.
    setCode("");
    setBusy(null);
    router.refresh();
  }

  async function remove(target: string) {
    if (busy) return;
    setError(null);
    setBusy(target);
    const res = await checkoutRemoveCouponAction(target);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "We could not remove that code.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2 border-t bg-muted/40 px-5 py-3">
      {applied.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {applied.length > 1 ? "Discounts applied" : "Discount applied"}
          </span>
          {applied.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 font-mono text-xs"
            >
              {c}
              <button
                type="button"
                onClick={() => remove(c)}
                disabled={!!busy}
                aria-label={`Remove ${c}`}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <CouponRefusals refusals={refusals} />

      <form onSubmit={apply} className="flex flex-wrap items-center gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Coupon code"
          aria-label="Coupon code"
          spellCheck={false}
          maxLength={100}
          className="h-8 w-48 font-mono text-xs"
        />
        {/* `outline`, not a filled button: on a storefront route `--solid` is rewritten to
            the MERCHANT's raw brand colour (lib/brand.ts), and a full-strength brand button
            for a secondary action shouts over the one that actually completes the
            checkout. */}
        <Button type="submit" size="sm" variant="outline" disabled={!code.trim() || !!busy}>
          {busy === "apply" ? "Applying…" : "Apply"}
        </Button>
      </form>

      {error ? (
        <Alert tone="error" className="text-xs">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Codes on the page that completion would refuse (expired, not yet valid, used up). The
 * totals already leave them out, so the buyer is told why the discount is missing.
 */
export function CouponRefusals({ refusals }: { refusals: Record<string, string> }) {
  const entries = Object.entries(refusals);
  if (entries.length === 0) return null;
  return (
    <Alert tone="error" className="text-xs">
      {entries.map(([code, message]) => (
        <div key={code}>{message}</div>
      ))}
    </Alert>
  );
}
