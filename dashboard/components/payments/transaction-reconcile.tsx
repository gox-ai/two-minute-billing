"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AttentionCard } from "@/components/patterns/record-page";
import { SelectField } from "@/components/ui/select-field";
import { reconcileTransactionAction } from "@/app/(dashboard)/businesses/[biz]/transactions/actions";
import { money } from "@/lib/format";
import type { Transaction } from "@/lib/api/payments";

/**
 * Confirm + verdict-select form for reconciling a needs_attention / timeout txn,
 * rendered as the transaction page's Needs attention card.
 *
 * ── WHY IT HAS TWO SHAPES (#17, measured 2026-09-03) ────────────────────────────
 * A `needs_attention` authorization for ₹22,184.00
 * rendered this form saying "The gateway outcome is unknown", with "Succeeded — money was
 * captured" PRE-SELECTED and "Confirm succeeded" under "This is irreversible". The
 * outcome was not unknown: we had captured AND refunded that charge ourselves six minutes
 * earlier and hold RazorPay's own refund id for it. Confirming it
 * would have inserted a payment, claimed it succeeded, and — the invoice being already
 * paid — posted `cash` debit ₹22,184.00 / `excess_payment_balance` credit ₹22,184.00: cash
 * that does not exist plus a credit the customer is not owed, through an append-only
 * ledger.
 *
 * So when the engine can see a settled refund against this row's money (`settled_refund`,
 * from `serializeTransaction`) the form states that fact instead of claiming ignorance,
 * and offers only the verdict the engine will accept. `reconcileTransaction` refuses
 * `succeeded` there with a 400 — the select is not the guard, it just stops offering a
 * button that cannot work. No `succeeded` option is RENDERED rather than rendered
 * disabled: a disabled option in a two-option select implies a choice exists.
 */
export function TransactionReconcileForm({
  biz,
  txn,
  settledRefund,
}: {
  biz: string;
  txn: string;
  /** Money on this row that the gateway has already returned. Null ⇒ genuinely unknown. */
  settledRefund?: Transaction["settled_refund"];
}) {
  const router = useRouter();
  const returned = settledRefund ?? null;
  const [outcome, setOutcome] = React.useState<"succeeded" | "failed">(
    returned ? "failed" : "succeeded",
  );
  const [state, formAction, pending] = useActionState(reconcileTransactionAction, null);
  const seen = React.useRef<typeof state>(null);

  React.useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) {
      if (state.message) toast.success(state.message);
      router.refresh();
    } else if (state.code === "conflict") {
      toast.error(state.message ?? "This transaction changed", {
        action: { label: "Reload", onClick: () => window.location.reload() },
        duration: 8000,
      });
    } else if (state.message) {
      toast.error(state.message);
    }
  }, [state, router]);

  return (
    <AttentionCard
      items={[
        returned
          ? {
              key: "reconcile",
              tone: "attention",
              title: "Reconcile: this money is already returned",
              detail: (
                <>
                  The gateway outcome is known.{" "}
                  {money(returned.refunded_minor, returned.currency ?? "")}{" "}
                  {returned.fully_returned ? "was refunded in full" : "was partly refunded"} on the
                  charge for this row. If you confirm it as succeeded, we would book cash that does
                  not exist. Thus, only the failed verdict is available. This verdict settles the
                  transaction and its linked payment. You cannot undo it.
                </>
              ),
            }
          : {
              key: "reconcile",
              tone: "attention",
              title: "Reconcile: set the operator verdict",
              detail:
                "The gateway outcome is unknown. Your verdict settles the transaction, its linked payment and the invoice. You cannot undo this.",
            },
      ]}
    >
      <form action={formAction} className="flex flex-col gap-3 px-5 py-4">
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="txn" value={txn} />
        <input type="hidden" name="outcome" value={outcome} />
        {returned ? (
          <dl className="max-w-xl space-y-1 rounded-md bg-card p-3 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Gateway charge</dt>
              <dd className="font-mono break-all">{returned.charge_at_gateway}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Gateway refund</dt>
              <dd className="font-mono break-all">{returned.provider_refund_id ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Refund</dt>
              <dd className="font-mono break-all">{returned.refund ?? "—"}</dd>
            </div>
            {returned.payment ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Payment</dt>
                <dd className="font-mono break-all">{returned.payment}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <div className="max-w-sm">
            {/* SelectField, not raw Select: it drops the mount-time value Radix restores when
                React resets the form, which would otherwise flip a failed retry's verdict. */}
            <SelectField
              value={outcome}
              onValueChange={(v) => setOutcome(v as "succeeded" | "failed")}
              ariaLabel="Verdict"
              className="bg-card"
              options={[
                { value: "succeeded", label: "Succeeded: the money was captured" },
                { value: "failed", label: "Failed: no money moved" },
              ]}
            />
          </div>
        )}
        <div>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            {pending ? "Working…" : `Confirm ${outcome}`}
          </Button>
        </div>
      </form>
    </AttentionCard>
  );
}
