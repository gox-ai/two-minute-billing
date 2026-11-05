"use client";

import * as React from "react";
import { setSubscriptionCreditUsageAction } from "@/app/actions";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { majorStep, minorPerMajor, toMajorInput } from "@/lib/money";
import { money } from "@/lib/format";

/**
 * `useFieldError` reads the enclosing ActionForm's result, so it must be called from a
 * CHILD of the form rather than the component that returns it.
 */
function LimitError() {
  const error = useFieldError("limit");
  if (!error) return null;
  return <p className="w-full text-xs font-medium text-destructive">{error}</p>;
}

/**
 * Cap automatic credit application on ONE subscription, in place.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Credits Flexibility is a BUSINESS setting (Settings → Billing rules), so turning
 * auto-apply off to reason about a single subscription meant changing it for every
 * customer. The engine has always taken a per-subscription ceiling —
 * `max_refundable_credits_usage_minor` / `max_excess_payment_usage_minor`, resolved by
 * `creditApplicationLimits` — and the business screen's own footnote said there was no
 * screen for it. This is that screen.
 *
 * ── THREE STATES, AND WHY A NUMBER BOX ALONE CANNOT DO IT ───────────────────────
 * `null`, `0` and `N` are three different answers: follow the business setting, never
 * auto-apply here, or auto-apply up to N. A blank box would have to mean either the
 * first or the second. Same two-control shape as `BillingCyclesInline`, for the same
 * reason.
 *
 * ── IT ONLY NARROWS ────────────────────────────────────────────────────────────
 * `creditApplicationLimits` takes the TIGHTER of this and the business ceiling, so a
 * generous number here cannot widen a business set to "Do not auto-apply". The resting
 * copy says which setting is actually in force, because a merchant who sets a limit and
 * then sees no credit applied would otherwise have no way to tell why.
 */
export function CreditUsageInline({
  biz,
  sub,
  kind,
  value,
  currency,
  businessAllows,
  canEdit,
}: {
  biz: string;
  sub: string;
  kind: "refundable" | "excess";
  /** Minor units. null = no subscription ceiling; 0 = never; N = up to N. */
  value: number | null | undefined;
  currency: string | null | undefined;
  /**
   * Whether the BUSINESS setting lets this kind auto-apply to a recurring invoice at
   * all. False means the business already says no, and this row cannot change that —
   * stated rather than left for the merchant to discover from an invoice.
   */
  businessAllows: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const initialMode = value == null ? "inherit" : value === 0 ? "none" : "limit";
  const [mode, setMode] = React.useState(initialMode);

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-foreground">
        <span>
          {value == null ? (
            <>
              Follows the business setting
              {!businessAllows ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  which does not auto-apply
                </span>
              ) : null}
            </>
          ) : value === 0 ? (
            "Never auto-applies"
          ) : (
            <>
              Up to {money(value, currency ?? "")}
              {!businessAllows ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  but the business setting does not auto-apply
                </span>
              ) : null}
            </>
          )}
        </span>
        {canEdit ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              setMode(initialMode);
              setEditing(true);
            }}
          >
            Change
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <ActionForm
      action={setSubscriptionCreditUsageAction}
      className="flex flex-wrap items-center gap-2"
      onSuccess={() => setEditing(false)}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <input type="hidden" name="kind" value={kind} />
      {/* The form edits major units; the action needs the currency's scale to convert. */}
      <input type="hidden" name="minor_per_major" value={minorPerMajor(currency)} />
      <SelectField
        name="mode"
        value={mode}
        onValueChange={setMode}
        ariaLabel={
          kind === "refundable"
            ? "Refundable credit on this subscription"
            : "Excess payments on this subscription"
        }
        className="h-7 w-auto min-w-52 text-xs"
        options={[
          { value: "inherit", label: "Follow the business setting" },
          { value: "none", label: "Never auto-apply here" },
          { value: "limit", label: "Auto-apply up to a limit" },
        ]}
      />
      {mode === "limit" ? (
        <span className="flex items-center gap-1.5">
          <Input
            name="limit"
            type="number"
            min={0}
            step={majorStep(currency)}
            defaultValue={toMajorInput(value ?? 0, currency)}
            className="h-7 w-24 text-right text-xs tabular-nums"
            aria-label="Maximum credit to auto-apply per invoice"
          />
          <span className="text-xs text-muted-foreground">{currency ?? ""} per invoice</span>
        </span>
      ) : null}
      <SubmitButton size="sm" className="h-7 px-2 text-xs">
        Save
      </SubmitButton>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      <LimitError />
    </ActionForm>
  );
}
