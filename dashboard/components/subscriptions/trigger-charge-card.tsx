"use client";

// CAT-4: attached charge items of the subscription's plan, each with a
// quantity input + "Trigger charge" (POST …/:sub/trigger_charge). The
// applicable_plans GET does not expose charge_on_event, so every attached
// charge-kind product is listed; the backend rejects non-on-demand items with
// a clear 400 that surfaces as a toast.

import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { money } from "@/lib/format";
import { triggerChargeAction } from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";

export interface TriggerChargeRow {
  productId: string;
  productName: string;
  applicability: string;
  amountMinor: number | null;
  currency: string | null;
  interval: string | null;
}

/**
 * Inline error for the row's `quantity` field. Its own component (not read
 * directly in `TriggerChargeCard`) because `useFieldError` reads the nearest
 * `<ActionForm>` provider ABOVE it in the render tree — that provider only
 * exists once this row's `<ActionForm>` has actually rendered its children.
 */
function QuantityError({ productName }: { productName: string }) {
  const error = useFieldError("quantity");
  if (!error) return null;
  return (
    <p className="w-full text-xs font-medium text-destructive" role="alert">
      {productName}: {error}
    </p>
  );
}

export function TriggerChargeCard({
  biz,
  sub,
  rows,
}: {
  biz: string;
  sub: string;
  rows: TriggerChargeRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <ActionForm
          key={r.productId}
          action={triggerChargeAction}
          className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <input type="hidden" name="attached_item" value={r.productId} />
          <span className="flex min-w-48 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              {r.productName}
              <Chip className="px-1.5 py-0 text-xs capitalize">{r.applicability}</Chip>
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {r.productId}
              {r.amountMinor != null && r.currency ? ` · ${money(r.amountMinor, r.currency)}` : ""}
              {r.interval ? `/${r.interval}` : ""}
            </span>
          </span>
          <Input
            name="quantity"
            type="number"
            min={1}
            step={1}
            placeholder="qty (default 1)"
            className="w-36 tabular-nums"
            aria-label={`Quantity for ${r.productName}`}
          />
          <SubmitButton variant="outline" size="sm">
            Trigger charge
          </SubmitButton>
          <QuantityError productName={r.productName} />
        </ActionForm>
      ))}
      <p className="text-xs text-muted-foreground">
        A trigger invoices the charge now. If auto-collection is on, we also collect it. You can
        trigger only <b className="text-foreground">on-demand</b> attached items. The API refuses
        other items.
      </p>
    </div>
  );
}
