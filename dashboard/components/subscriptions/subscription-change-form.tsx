"use client";

// Full-page "Change subscription" flow: line builder
// pre-filled from the current items, add/remove lines, quantity + unit-price
// override, mandatory-addon auto-include for the selected plan (non-removable,
// "Required" badge), and a live proration estimate rail (POST …/:sub/estimate).
//
// Apply semantics (backend has three separate ops):
//   modified existing items → POST /change (one prorated batch)
//   new lines               → POST /items (prorated per item)
//   removed existing items  → DELETE /items/:id (credits unused time)
// The estimate endpoint prices ALL THREE in one preview, so the rail and the confirm
// dialog state the whole amount that will move. It used to cover only /change, which
// is how a removal came to preview as "No immediate charge" while the apply credited
// unused time — a false statement about money on a confirmation screen.

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SummaryBox } from "@/components/patterns/section-card";
import { RecordCard } from "@/components/patterns/record-page";
import { FormCard, LockedField, Wide } from "@/components/catalog/form-kit";
import {
  ChoiceCardsField,
  FieldBlock,
  FooterFigure,
  ShortLabel,
  SubFormFrame,
} from "@/components/subscriptions/sub-form-frame";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { DateTimeField } from "@/components/form/datetime-field";
import { Field } from "@/components/form/field";
import { ErrorState } from "@/components/states";
import { money, fmtDate, fmtDateTime, isQuantityBased, toMajor, toMinor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MoreVertical, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type {
  Coupon,
  Discount,
  Price,
  Product,
  ProductGroup,
  RenewalEstimate,
  SubscriptionItem,
} from "@/lib/api";
import type {
  ChangeEstimate,
  PlanAddonRule,
  SubscriptionChangeLine,
} from "@/lib/api/subscriptions";
import { differentialAmount, type DifferentialRule } from "@/lib/differential";
import { creditLegSentences, creditNarrativeFromEstimate } from "@/lib/credit-legs";
import {
  applySubscriptionChangeAction,
  applySubscriptionReactivationAction,
  estimateSubscriptionChangeAction,
  type ChangePayload,
  estimateSubscriptionReactivationAction,
  type ReactivationPayload,
} from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";

import {
  ChangeSummaryDialog,
  type SummaryDiffRow,
  type SummaryChargeLine,
} from "@/components/subscriptions/change-summary-dialog";

// Line table and catalog picker are SHARED with the create form — one table
// serves both pages. Style there, never per row here.
import { CatalogAddModal } from "@/components/subscriptions/catalog-add-modal";
import {
  INTERVAL_LABEL,
  LineActionLink,
  LineActionSeparator,
  LineActionsBar,
  LineGroupLabel,
  LineItemsCard,
  LineRow,
  lineSubtitle,
} from "@/components/subscriptions/line-items";
import {
  CouponPickerModal,
  couponDiscountLabel,
  couponDurationLabel,
} from "@/components/subscriptions/coupon-picker-modal";
import { makeEstimateLineFormatter } from "@/lib/estimate-lines";
import { SelectField } from "@/components/ui/select-field";
import { changeEditKey, policyReady, prorateToSend } from "@/lib/change-policy-view";
import { useDefaultState } from "@/lib/use-default-state";
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import {
  ALLOWANCE_UPGRADE_LABELS,
  CREDIT_DOWNGRADE_LABELS,
  CREDIT_UPGRADE_LABELS,
  DOWNGRADE_CREDIT_LABELS,
  FAILED_CHANGE_LABELS,
  PLAN_CHANGE_COUPON_LABELS,
  type ChangeRuleDefaults,
} from "@/lib/billing-rules";
import type { ChangeRuleOverrides } from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";
import { MetadataField, type MetadataEditorData } from "@/components/form/metadata-field";

/** Client-side term advance for the reactivation "new term" preview. */
function addTerm(d: Date, unit: string | null | undefined, count: number): Date {
  const r = new Date(d);
  if (unit === "day") r.setDate(r.getDate() + count);
  else if (unit === "week") r.setDate(r.getDate() + 7 * count);
  else if (unit === "year") r.setFullYear(r.getFullYear() + count);
  else r.setMonth(r.getMonth() + count);
  return r;
}

/** Models whose per-unit amount can be overridden (backend rejects others). */
const OVERRIDABLE_MODELS = new Set(["flat", "per_unit"]);

interface ExistingLine {
  kind: "existing";
  itemId: string;
  originalPrice: string;
  price: string;
  originalQuantity: number;
  quantity: number;
  /** '' = keep the current unit price. */
  unit_price_minor: string;
  /** The item's effective per-unit price snapshot (reflects any prior override / differential). */
  itemUnitMinor: number | null;
  removed: boolean;
  productName?: string;
  required: boolean;
}

interface NewLine {
  kind: "new";
  price: string;
  quantity: number;
  unit_price_minor: string;
  /** Which section this row belongs to (governs its dropdown + grouping). */
  slot: "addon" | "charge";
  /** Auto-included mandatory addon of the selected plan — non-removable. */
  required: boolean;
}

type Line = ExistingLine | NewLine;

/** The options of a label map, in its order. */
const labelOptions = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

const ruleHelp = (label: string) =>
  `Applies to this change only. The business setting is “${label}”.`;

export function SubscriptionChangeForm({
  biz,
  defaultInvoiceImmediately,
  reactivationCharges = "invoice_immediately",
  reactivationChargeFailure = "refuse",
  changeRules,
  sub,
  businessName,
  currency,
  items,
  prices,
  products,
  productGroups,
  rules,
  differentials,
  coupons,
  appliedDiscount,
  customerId,
  customerName,
  customerAutoCollection,
  status,
  currentPeriodEnd,
  trialEnd,
  firstTerm,
  hasPaymentMethod,
  autoCollection,
  poNumber,
  invoiceNotes,
  metadata,
  metadataEditor,
  remainingBillingCycles,
  error,
  tz,
}: {
  biz: string;
  /** The business's `default_invoice_immediately`, which the engine applies when a request omits it. */
  defaultInvoiceImmediately: boolean;
  /** `billing_rules_config.reactivation_charges`: what a reactivation without a choice does. */
  reactivationCharges?: "invoice_immediately" | "add_to_unbilled_charges";
  /** The business rule for a failed reactivation charge, resolved: the choice's preselection. */
  reactivationChargeFailure?: "refuse" | "dun";
  /** The rules a change may override for itself, resolved: the Change options' preselections. */
  changeRules: ChangeRuleDefaults;
  sub: string;
  businessName: string;
  currency: string;
  items: SubscriptionItem[];
  prices: Price[];
  products: Product[];
  productGroups: ProductGroup[];
  rules: PlanAddonRule[];
  differentials: DifferentialRule[];
  /** Catalog coupons, for the `Add Coupon` picker (vs the `Add Coupon Code` box). */
  coupons: Coupon[];
  /**
   * The discount ALREADY on this subscription, or null.
   *
   * This screen showed no sign of one: `couponCode` starts empty and the Coupons group
   * renders only what the operator types here, so editing a discounted subscription
   * looked identical to editing an undiscounted one — and the add-coupon controls were
   * offered on both, though the engine allows exactly one discount and refuses the
   * second ("A discount is already applied to this subscription").
   */
  appliedDiscount?: Discount | null;
  /** The payer — shown as a customer chip in this page's header. */
  customerId: string;
  customerName: string;
  /** The customer's stored auto-collection: what the "inherit" option resolves to. */
  customerAutoCollection?: "on" | "off" | null;
  status: string;
  currentPeriodEnd?: string;
  trialEnd?: string | null;
  /**
   * The in-trial subscription's FIRST-TERM invoice estimate (the one the trial end
   * raises). Only "End the trial now" needs it: that call bills this today, and no other
   * figure on this screen describes it — the change estimate prices the item edits.
   * Null when not in trial, or when the estimate could not be fetched.
   */
  firstTerm?: RenewalEstimate | null;
  /** Whether the payer has any payment method on file — see the page's own note. */
  hasPaymentMethod?: boolean | null;
  autoCollection?: "on" | "off" | null;
  poNumber?: string | null;
  invoiceNotes?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Rules, settings and suggestions for the metadata editor; null = the plain JSON field. */
  metadataEditor?: MetadataEditorData | null;
  /**
   * `sub.remaining_billing_cycles` — renewals left AFTER the current term; `null` renews
   * forever. REQUIRED, and deliberately not optional: an absent value would have to mean
   * "not known yet", and the Billing Cycles control below cannot render honestly without
   * it (defaulting to Forever on a capped subscription both misreports the current state
   * and posts itself as an edit). Making it required is what lets the compiler, rather
   * than a disabled control at runtime, catch a caller that forgets.
   */
  remainingBillingCycles: number | null;
  error?: string;
  /** Business IANA timezone — proration dates render in it, not UTC. */
  tz?: string | null;
}) {
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const priceById = React.useMemo(() => new Map(prices.map((p) => [p.id, p])), [prices]);
  const productOfPrice = (priceId: string) =>
    productById.get(priceById.get(priceId)?.product ?? "");
  const kindOf = (priceId: string) => productOfPrice(priceId)?.kind ?? null;
  // NOTE — `priceLabel` and `pricesByKind` lived here and are gone: they existed only to
  // fill the flat per-row price `Select`, which the catalog modal replaced (see
  // `priceEdit` below). `priceLabel` was also the ₹0.00 bug — it formatted
  // `price.amount_minor`, the raw catalog list price, with no differential resolution.
  // `catalogPricesFor` carries the same-currency rule they enforced.

  const mandatoryFor = React.useCallback(
    (planProductId: string | undefined) =>
      planProductId
        ? rules
            .filter((r) => r.plan === planProductId && r.level === "mandatory")
            .map((r) => r.addon)
        : [],
    [rules],
  );

  const [lines, setLines] = React.useState<Line[]>(() => {
    const initial: Line[] = items
      .filter((it) => it.id)
      .map((it) => ({
        kind: "existing" as const,
        itemId: it.id!,
        originalPrice: it.price,
        price: it.price,
        originalQuantity: it.quantity || 1,
        quantity: it.quantity || 1,
        unit_price_minor: "",
        itemUnitMinor: it.unit_price_minor ?? null,
        removed: false,
        productName: it.product_name,
        required: false,
      }));
    return initial;
  });

  // Current plan product = the plan-kind line's (possibly changed) price's product.
  const planLine = lines.find((l) => !("removed" in l && l.removed) && kindOf(l.price) === "plan");
  const planProduct = planLine ? productOfPrice(planLine.price) : undefined;
  const planPrice = planLine ? priceById.get(planLine.price) : undefined;

  // ── PRODUCT GROUP ──────────────────────────────────────────────────────────
  //
  // This was a DISABLED text input with a red asterisk reading "Platform", while
  // the plan picker below it offered 72 prices spanning all three groups
  // (platform, gds, gs). So it was a false statement, not a guard: the
  // engine has no group constraint — `product_groups` "carries no billing semantics"
  // (db/schema/catalog.ts:18), nothing in `subscriptions/` reads it, and a cross-group
  // plan swap estimates cleanly (measured 2026-08-24: platform-pro → gds-pro returned
  // −₹17,119.00, a clean downgrade credit).
  //
  // Same control and same reasoning as the CREATE form's (see its own note): it
  // POSTS NOTHING, because there is no subscription-level group column to post to —
  // the group is whatever the chosen plan's product belongs to. It is a FILTER, so it
  // carries no asterisk. To make it a real required field, add a group column to the
  // subscription first.
  //
  // ONE difference from create, and it is deliberate: create defaults to "All product
  // groups" because there is no plan yet; here it defaults to the subscription's
  // CURRENT group, so the screen opens on the catalog the operator expects. Switching
  // it is what lets them move the subscription to another group's plan. It works
  // because it is just a normal plan change.
  const [group, setGroup] = React.useState<string>(planProduct?.product_group ?? "");
  const inGroup = (p: Product | undefined): boolean => !group || p?.product_group === group;
  const groupName = (id: string | null | undefined): string =>
    productGroups.find((g) => g.id === id)?.name ?? id ?? "—";

  /**
   * Effective per-unit price for a line, in minor units. Precedence:
   *   1. explicit override typed into the row
   *   2. an existing item's stored snapshot (only while its price is unchanged) —
   *      this reflects any prior custom price / differential and fixes the bug
   *      where overridden addons rendered ₹0.00 against the catalog price
   *   3. the plan-specific differential price for an addon, if configured
   *   4. the catalog list price
   */
  const effectiveUnitMinor = (l: Line): number => {
    if (l.unit_price_minor !== "") return Number(l.unit_price_minor);
    const price = priceById.get(l.price);
    if (l.kind === "existing" && l.price === l.originalPrice && l.itemUnitMinor != null)
      return l.itemUnitMinor;
    if (price && kindOf(l.price) === "addon") {
      const diff = differentialAmount(
        differentials,
        price.product,
        planProduct?.id,
        price.currency,
        price.interval,
      );
      if (diff != null) return diff;
    }
    return price?.amount_minor ?? 0;
  };

  /**
   * What the Add dialog should PRICE a candidate at — the same differential resolution the
   * line will get, so the dialog cannot offer ₹0.00 and then add a ₹752.00 line. Not folded
   * into the plan's cycle: the dialog offers the item's own cadence; the ×N is the line's.
   */
  const effectiveCatalogAmount = (price: Price): number | null => {
    const diff = differentialAmount(
      differentials,
      price.product,
      planProduct?.id,
      price.currency,
      price.interval,
    );
    return diff ?? price.amount_minor ?? null;
  };

  // Billing frequency change on the plan line — server auto-resets the term when true.
  const planOriginalPrice =
    planLine && planLine.kind === "existing" ? priceById.get(planLine.originalPrice) : undefined;
  const frequencyChanged = Boolean(
    planLine &&
    planLine.kind === "existing" &&
    planLine.price !== planLine.originalPrice &&
    planPrice &&
    planOriginalPrice &&
    (planPrice.interval !== planOriginalPrice.interval ||
      (planPrice.interval_count ?? 1) !== (planOriginalPrice.interval_count ?? 1)),
  );

  /** Best price for an addon product: plan currency + interval match preferred. */
  const bestAddonPrice = React.useCallback(
    (addonProductId: string): Price | undefined => {
      const candidates = prices.filter(
        (p) => p.product === addonProductId && p.active !== false && p.currency === currency,
      );
      return candidates.find((p) => p.interval === planPrice?.interval) ?? candidates[0];
    },
    [prices, currency, planPrice?.interval],
  );

  const requiredProductIds = React.useMemo(
    () => new Set(mandatoryFor(planProduct?.id)),
    [mandatoryFor, planProduct?.id],
  );

  // Keep mandatory addons of the selected plan present + flagged required.
  React.useEffect(() => {
    setLines((ls) => {
      const present = new Set(
        ls
          .filter((l) => !(l.kind === "existing" && l.removed) && !(l.kind === "new" && !l.price))
          .map((l) => productOfPrice(l.price)?.id)
          .filter(Boolean),
      );
      let next: Line[] = ls.map((l) => {
        const pid = productOfPrice(l.price)?.id;
        const required = pid != null && requiredProductIds.has(pid);
        // Un-remove a required existing item; drop auto-added lines no longer required.
        if (l.kind === "existing") return { ...l, required, removed: required ? false : l.removed };
        return { ...l, required };
      });
      // Drop auto-added new lines that are no longer mandatory (plan changed away).
      next = next.filter(
        (l) => !(l.kind === "new" && l.required === false && l.price !== "" && false),
      );
      const added: Line[] = [];
      for (const addonProductId of requiredProductIds) {
        if (present.has(addonProductId)) continue;
        const price = bestAddonPrice(addonProductId);
        if (price)
          added.push({
            kind: "new",
            price: price.id,
            quantity: 1,
            unit_price_minor: "",
            slot: "addon",
            required: true,
          });
      }
      if (added.length === 0 && next.every((l, i) => JSON.stringify(l) === JSON.stringify(ls[i])))
        return ls;
      return [...next, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [[...requiredProductIds].sort().join(","), bestAddonPrice]);

  // The trial control is "move the date" OR "end it now", and ending now is a different
  // backend call — POST …/edit_trial_end {immediately:true}, which activates the
  // subscription and invoices the first term today rather than at the trial boundary.
  //
  // Declared HERE, ahead of the rest of the trial controls it belongs with, because
  // `termEndAnchor` below has to see it: "apply on activation" and "end the trial now"
  // are the same instant expressed two ways, and offering both would preview a boundary
  // the operator is deleting in the same submit.
  const [endTrialNow, setEndTrialNow] = React.useState(false);

  // ── Apply Changes (immediately / at renewal / a scheduled date) ─────────────
  //
  // `end_of_term` is "On next renewal" and is NOT a third backend op —
  // it is the schedule path with `effective_at` preset to the current term end.
  // The clock applies due scheduled changes BEFORE the renewal pass in the same
  // tick (src/platform/jobs.ts), so the new composition is what the renewal bills.
  /**
   * The business's plan-change rules for the edit on screen, from the last estimate:
   * the timings `/change` accepts, its default, the gate and the proration. Null until an
   * estimate for line work arrives.
   */
  const [policy, setPolicy] = React.useState<ChangeEstimate["change_policy"] | null>(null);
  /** The edit the last estimate answered (see `policyReady`). */
  const [answeredKey, setAnsweredKey] = React.useState<string | null>(null);
  /** The edit the newest estimate request was for; an older answer is dropped. */
  const askedKeyRef = React.useRef<string | null>(null);
  /** The items and timing of the last estimate: a change of either is a new edit. */
  const shapeKeyRef = React.useRef<string | null>(null);
  /** The operator's pick; null = follow the business rule. */
  const [applyWhenChoice, setApplyWhen] = React.useState<
    "immediately" | "end_of_term" | "specific_date" | null
  >(null);
  const [applyAt, setApplyAt] = React.useState("");
  /** The operator's pick; null = follow the business rule (`change_policy.reset_term`). */
  const [resetTermChoice, setResetTerm] = React.useState<boolean | null>(null);
  /**
   * The instant "defer this to the end of the current commitment" resolves to — and the
   * reason this option now appears IN TRIAL, where it used to be dropped.
   *
   * The serializer reports `current_period_end: null` for the whole trial on purpose (no
   * billing term until the trial converts). This option was gated on that field
   * alone, so a trialling subscription lost it — but the date it wanted exists under a
   * different name. `trial_end` IS the boundary a trial renews from (renewal.ts) and the
   * instant the subscription activates — hence the "On Activation" label.
   *
   * What lands is right for the same reason it is right at a term end. The scheduled
   * change applies during the `scheduled_changes` pass, which runs BEFORE `renewal` in
   * the same tick, while the subscription is still `in_trial` — so `billsAtTrialEnd`
   * drops every money artefact (no proration, no credit) and only the composition moves.
   * The renewal pass then activates and bills the FIRST invoice off the new composition,
   * which is exactly what deferring a change to activation means.
   */
  const termEndAnchor =
    currentPeriodEnd ?? (status === "in_trial" && !endTrialNow ? (trialEnd ?? null) : null);
  const canApplyAtTermEnd = Boolean(termEndAnchor);
  const allowNow = !policy || policy.timings.includes("now");
  const allowLater = !policy || policy.timings.includes("end_of_term");
  // Preselect the business rule's timing; a pick the rule no longer allows (the edit
  // changed direction) falls back to it.
  const ruleApplyWhen =
    policy?.default_timing === "end_of_term" && canApplyAtTermEnd ? "end_of_term" : "immediately";
  const applyWhen =
    applyWhenChoice && (applyWhenChoice === "immediately" ? allowNow : allowLater)
      ? applyWhenChoice
      : ruleApplyWhen;
  /** What to call that boundary in prose: a trial ends by activating, not by renewing. */
  const termEndNoun = status === "in_trial" ? "activation" : "the next renewal";
  // Picking "on activation" and THEN ticking "end the trial now" would leave the radio
  // checked but no longer rendered, and `effective_at` empty — a disabled submit whose
  // cause is off screen. Fall back to the one mode that is always available.
  React.useEffect(() => {
    if (!canApplyAtTermEnd && applyWhen === "end_of_term") setApplyWhen("immediately");
  }, [canApplyAtTermEnd, applyWhen]);
  /** True for every apply mode that goes through POST …/schedule. */
  const applyIsScheduled = applyWhen !== "immediately";
  /** The instant actually posted as `apply.at` (empty ⇒ nothing to schedule yet). */
  const effectiveApplyAt =
    applyWhen === "end_of_term"
      ? (termEndAnchor ?? "")
      : applyWhen === "specific_date"
        ? applyAt
        : "";
  // A scheduled change replays `changeSubscription` with no `reset_term`, so the
  // checkbox is meaningless (and a frequency change cannot force it) once deferred.
  // Untouched, nothing is sent and the estimate states the business rule's answer.
  const resetTermSent = applyIsScheduled
    ? undefined
    : frequencyChanged
      ? true
      : (resetTermChoice ?? undefined);
  const resetTerm = resetTermChoice ?? policy?.reset_term ?? false;
  const effectiveResetTerm = applyIsScheduled ? false : resetTerm || frequencyChanged;

  /**
   * `prorate` — whether prorated credits and charges are created for the change.
   * Defaults TRUE, and the checkbox is checked and EDITABLE.
   *
   * It rendered checked and DISABLED, captioned "Changes always prorate against the
   * current term" — which stopped being true on 2026-08-22, when `changeSubBody.prorate`
   * landed (subscription-routes.ts:232). What `false` actually does in our engine
   * (proration.ts:544-558):
   *   · same cadence → both sides of the movement are prorated, so NOTHING is booked:
   *     the composition changes, no invoice, no credit note;
   *   · term reset (a frequency change, or `reset_term`) → the full new-term charge is
   *     not a prorated artefact and still happens; only the unused-time CREDIT is
   *     dropped.
   *
   * Rides on POST …/:sub/change, so like `invoice_immediately` it is real only for an
   * immediate change of existing lines — a scheduled change stores no such flag, and in
   * trial there is nothing to prorate at all.
   */
  const [prorateChoice, setProrate] = React.useState<boolean | null>(null);
  /** The operator's pick, else the business rule for this edit's direction (from the estimate). */
  const prorate = prorateChoice ?? policy?.prorate ?? true;

  // ── Billing Info ─────────────────────────────────────────────────────────
  const [autoCollectionState, setAutoCollectionState] = React.useState(autoCollection ?? "");
  const [poNumberState, setPoNumberState] = React.useState(poNumber ?? "");
  const [invoiceNotesState, setInvoiceNotesState] = React.useState(invoiceNotes ?? "");
  // Raw text, compared to what the field started with: unchanged means not sent.
  const metadataInitial =
    metadata && Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : "";
  const [metadataText, setMetadataText] = React.useState(metadataInitial);
  const [metadataValid, setMetadataValid] = React.useState(true);

  /**
   * ── BILLING CYCLES (subscription-level) ────────────────────────────────────────
   * Billing Info carries a Fixed/Forever `Billing Cycles` select. We had it on CREATE
   * only and on the detail page's own inline row; the change page had no way to cap or
   * uncap renewals. `PATCH …/subscriptions/:sub` has accepted
   * `remaining_billing_cycles` since 2026-08-22 (subscription-routes.ts:843).
   *
   * Semantics are `BillingCyclesInline`'s, deliberately word-for-word: renewals
   * remaining AFTER the current one — NOT a total. It is the counter `renewal.ts`
   * decrements, and 0 makes this term the last (the subscription reads `non_renewing`
   * and cancels at term end). `null` renews forever.
   */
  const [cyclesMode, setCyclesMode] = React.useState<"forever" | "count">(
    remainingBillingCycles == null ? "forever" : "count",
  );
  const [cyclesN, setCyclesN] = React.useState(
    remainingBillingCycles == null ? "" : String(remainingBillingCycles),
  );
  /** What the control currently describes, as the PATCH would carry it. */
  const cyclesValue: number | null =
    cyclesMode === "forever" || cyclesN.trim() === ""
      ? null
      : Math.max(0, Math.trunc(Number(cyclesN)));
  // Only a real edit posts. "Forever" on a subscription that already renews forever is
  // not a change, and a blank count is not an instruction.
  const cyclesChanged =
    cyclesMode === "forever"
      ? remainingBillingCycles !== null
      : cyclesN.trim() !== "" && cyclesValue !== remainingBillingCycles;

  // Prefilled with the CURRENT trial end, like every other field on this screen. A blank
  // picker read as "no trial end set" on a subscription that has one, and made the operator
  // re-derive the date they were about to move. `sameInstant` is what keeps the prefill from
  // counting as an edit: DateTimeField emits the prefill's own instant until the value is
  // actually changed, so an untouched screen stays clean and `dirty` stays false.
  const [trialEndAt, setTrialEndAt] = React.useState(trialEnd ?? "");
  // `endTrialNow` is declared up in the Apply Changes block — it gates the "on activation"
  // option there, which is evaluated before this point.
  const sameInstant = (a?: string | null, b?: string | null) => {
    if (!a || !b) return false;
    const x = new Date(a).getTime();
    const y = new Date(b).getTime();
    return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
  };
  const trialEndChanged = Boolean(trialEndAt) && !sameInstant(trialEndAt, trialEnd);
  /**
   * `edit_trial_end { immediately: true }` is REFUSED (400) when the subscription
   * auto-collects and the customer has no payment method at all — converting it would
   * cancel the subscription for `no_card` instead of activating it, so the engine says no
   * rather than doing that. Mirrored here so the screen says
   * why before the operator submits, rather than surfacing a 400 they cannot act on.
   */
  const effectiveAutoCollectOn = (autoCollectionState || customerAutoCollection || "on") !== "off";
  const endTrialBlocked = endTrialNow && effectiveAutoCollectOn && hasPaymentMethod === false;

  // ── Reactivation mode: editing a CANCELLED sub = fresh term from today ───────
  const reactivating = status === "cancelled";
  const [billingCyclesMode, setBillingCyclesMode] = React.useState<"forever" | "limited">(
    "forever",
  );
  const [billingCyclesN, setBillingCyclesN] = React.useState("");
  const [reactTrialEnd, setReactTrialEnd] = React.useState("");
  const [chargesHandling, setChargesHandling] = useDefaultState<
    "invoice_immediately" | "add_to_unbilled_charges"
  >(reactivationCharges);
  /** Offered only when the subscription can continue its term; "continue" is the default. */
  const [reactTerm, setReactTerm] = React.useState<"continue" | "new">("continue");
  const [chargeFailure, setChargeFailure] = useDefaultState<"refuse" | "dun">(
    reactivationChargeFailure,
  );

  // ── Invoicing Options ────────────────────────────────────────────────────────
  // `invoice_immediately` on POST …/:sub/change: raise the proration invoice now and
  // collect it, or queue the same lines as unbilled charges for the next renewal.
  //
  // Preselects the BUSINESS's own Invoicing Options default (Settings › Billing rules ›
  // Update subscription), not a hardcoded "Immediately".
  //
  // `changeSubscription` resolves that same column when a request omits
  // `invoice_immediately` (2026-08-19; it was a decorative setting until then), so this
  // is the "resolve the actual default and preselect it" rule: the screen previews the
  // real outcome, and a merchant who turned the setting off is not silently overridden by
  // the form.
  //
  // The form still posts the value explicitly either way, so nothing depends on the
  // engine's default at request time.
  const [invoiceImmediately, setInvoiceImmediately] = React.useState(defaultInvoiceImmediately);

  // ── Coupon / manual discount ────────────────────────────────────────────
  // ONE coupon: `ChangePayload` carries a single `coupon_code`, so the Coupons group
  // in the table below can only ever hold one row. Two ways in —
  // `Add Coupon` (browse the catalog) and `Add Coupon Code` (type it) — and both end
  // on this same field. We only ever had the second.
  const [couponCode, setCouponCode] = React.useState("");
  /** The applied discount is marked for removal; it goes with this edit, previewed first. */
  const [removeApplied, setRemoveApplied] = React.useState(false);
  /** The discount that will still be on the subscription after this edit. */
  const keptDiscount = removeApplied ? null : appliedDiscount;
  const [showCouponCode, setShowCouponCode] = React.useState(false);
  /** What's being typed into `Add Coupon Code`, before Apply promotes it. */
  const [couponDraft, setCouponDraft] = React.useState("");
  const appliedCoupon = coupons.find((c) => c.id === couponCode);
  const [mdOpen, setMdOpen] = React.useState(false);
  const mdValueRef = React.useRef<HTMLInputElement>(null);
  /**
   * ── OPENING THE MANUAL-DISCOUNT PANEL ──────────────────────────────────────────
   * Two entry points: the `+ Add manual discount` link in the bar, which sits directly
   * above the panel, and the PLAN kebab's `Add Manual Discount`,
   * which on a long table can be a screen away from it.
   *
   * The kebab item is ALWAYS enabled. Hiding it once the panel was open made a menu
   * item vanish for a reason the operator could not see from where they were standing,
   * and disabling it would be a control that does nothing — so instead a second
   * activation still does something real: it puts the cursor in the panel, which scrolls
   * it into view.
   *
   * Focusing from a menu item needs `onCloseAutoFocus`, not a timeout. Radix returns
   * focus to the trigger when a DropdownMenu closes, and `.focus()` scrolls — so a
   * `setTimeout(…, 0)` focus was silently undone and the kebab scrolled back into view
   * instead (measured: activeElement came back as the trigger button, twice). Preventing
   * that one restore is the documented way to hand focus somewhere else on close.
   */
  const wantsMdFocus = React.useRef(false);
  /** From the bar link — no menu in the way, so focus can move immediately. */
  const openManualDiscount = () => {
    setMdOpen(true);
    setTimeout(() => mdValueRef.current?.focus(), 0);
  };
  /** From a kebab — arm the focus and let `onCloseAutoFocus` below perform it. */
  const openManualDiscountFromMenu = () => {
    setMdOpen(true);
    wantsMdFocus.current = true;
  };
  const takeMdFocus = (e: Event) => {
    if (!wantsMdFocus.current) return;
    wantsMdFocus.current = false;
    e.preventDefault();
    mdValueRef.current?.focus();
  };
  const [mdType, setMdType] = React.useState<"percent" | "amount">("percent");
  const [mdValue, setMdValue] = React.useState("");
  const [mdDuration, setMdDuration] = React.useState<"one_time" | "forever">("one_time");
  // Money/quantity strictness: a percent discount must land in 1–100; an amount
  // just needs to be positive (its currency/minor-unit conversion happens server-side).
  const mdValueInvalid = Boolean(
    mdOpen &&
    mdValue !== "" &&
    (!Number.isFinite(Number(mdValue)) ||
      (mdType === "percent" ? Number(mdValue) < 1 || Number(mdValue) > 100 : Number(mdValue) <= 0)),
  );

  // ── Payload derivation ──────────────────────────────────────────────────────
  const changes: SubscriptionChangeLine[] = lines
    .filter((l): l is ExistingLine => l.kind === "existing" && !l.removed)
    .filter(
      (l) =>
        l.price !== l.originalPrice ||
        l.quantity !== l.originalQuantity ||
        l.unit_price_minor !== "",
    )
    .map((l) => ({
      item: l.itemId,
      ...(l.price !== l.originalPrice ? { price: l.price } : {}),
      ...(l.quantity !== l.originalQuantity ? { quantity: l.quantity } : {}),
      ...(l.unit_price_minor !== "" ? { unit_price_minor: Number(l.unit_price_minor) } : {}),
    }));
  const adds = lines
    .filter((l): l is NewLine => l.kind === "new" && l.price !== "")
    .map((l) => ({
      price: l.price,
      quantity: l.quantity || 1,
      ...(l.unit_price_minor !== "" ? { unit_price_minor: Number(l.unit_price_minor) } : {}),
    }));
  const removes = lines
    .filter((l): l is ExistingLine => l.kind === "existing" && l.removed)
    .map((l) => l.itemId);

  const settings: NonNullable<ChangePayload["settings"]> = {};
  if (autoCollectionState !== (autoCollection ?? ""))
    settings.auto_collection = autoCollectionState as "on" | "off" | "";
  if (poNumberState !== (poNumber ?? "")) settings.po_number = poNumberState;
  if (invoiceNotesState !== (invoiceNotes ?? "")) settings.invoice_notes = invoiceNotesState;
  // Same PATCH as the three above — `remaining_billing_cycles` rides the settings call,
  // not the /change one, because it is a property of the subscription rather than of
  // this edit.
  if (cyclesChanged) settings.remaining_billing_cycles = cyclesValue;
  if (!reactivating && metadataText !== metadataInitial) settings.metadata = metadataText;
  const hasSettingsChange = Object.keys(settings).length > 0;
  // The field takes an amount in MAJOR units (step 0.01); every route takes minor units.
  const manualDiscount =
    mdOpen && mdValue
      ? {
          type: mdType,
          value: mdType === "amount" ? toMinor(Number(mdValue), currency) : Number(mdValue),
          duration: mdDuration,
        }
      : undefined;
  /** Stable identities for the estimate effect's dependency list — see the note there. */
  const couponKey = couponCode || "";
  const manualDiscountKey = manualDiscount ? `${manualDiscount.type}:${manualDiscount.value}` : "";

  /**
   * Whether the Invoicing Options choice can actually reach the engine. It rides on
   * POST …/:sub/change, so it is real only for an IMMEDIATE change of existing lines:
   *  - a SCHEDULED change goes through POST …/:sub/schedule, whose stored change
   *    carries no invoicing option — it invoices when it lands. (The old wording here
   *    said `scheduled_changes` "has no column for one". It has no column for the item
   *    lists either: `payload` is jsonb and carries all three. Nothing stores an
   *    invoicing option because nothing has asked for one, and the applier passes
   *    `invoiceImmediately: true` EXPLICITLY so a landed change cannot silently defer
   *    into unbilled charges on a business whose default is off — that promise is what
   *    this section states, and it is a product gap, not a schema limit.)
   *  - IN TRIAL the engine raises no proration at all (proration.billsAtTrialEnd),
   *    so there is nothing to route either way;
   *  - REACTIVATION has its own control above, on /reactivate.
   * In each of those cases the section states the outcome instead of offering a
   * radio that would decide nothing.
   */
  const invoicingOptionApplies = !reactivating && !applyIsScheduled && status !== "in_trial";
  /**
   * Whether `prorate` can reach the engine — the same three exclusions, for the same
   * reasons: it rides POST …/:sub/change, a scheduled change stores no such flag, and
   * an in-trial change prorates nothing to suppress.
   */
  const prorateApplies = invoicingOptionApplies;
  /**
   * The prorate value that actually reaches the engine — `true` wherever the flag has
   * no route to it, so the estimate call and the apply call cannot disagree. Same shape
   * as `effectiveResetTerm` above, and for the same reason.
   */
  // Untouched, nothing is sent and the estimate resolves the business rule, which then
  // shows on the checkbox; the apply sends that same value.
  // At the term end the estimate is priced as the scheduled change books it (see
  // `estimateChangeOption`), which takes no prorate of its own.
  const estimateChangeOption = applyWhen === "end_of_term" ? ("end_of_term" as const) : undefined;
  const effectiveProrate = estimateChangeOption
    ? undefined
    : prorateApplies
      ? (prorateChoice ?? undefined)
      : true;
  /** The chosen outcome, once it is a choice at all. */
  const deferChargesToUnbilled = invoicingOptionApplies && !invoiceImmediately;
  // NOTE: "add to unbilled charges" WITH an added line used to be refused here
  // (`deferConflict`), because `POST …/items` had no invoicing option and always
  // invoiced — so the edit would have deferred its changes and charged its adds, and no
  // single figure on this screen could state the outcome. Both calls carry the option
  // as of 2026-08-19 and the server action sends the form's choice on each, so the
  // whole edit defers together and there is nothing left to refuse. Removals were never
  // affected: a removal only credits, and credits are immediate on both branches.

  const payload: ChangePayload = {
    changes,
    adds,
    removes,
    apply: applyIsScheduled ? { at: effectiveApplyAt } : { immediately: true },
    ...(hasSettingsChange ? { settings } : {}),
    ...(couponCode ? { coupon_code: couponCode } : {}),
    ...(manualDiscount ? { manual_discount: manualDiscount } : {}),
    ...(removeApplied ? { remove_discount: true } : {}),
    ...(endTrialNow ? { end_trial_now: true } : trialEndChanged ? { trial_end: trialEndAt } : {}),
    ...(resetTermSent !== undefined ? { reset_term: resetTermSent } : {}),
    // Always explicit when it applies — the route treats an omitted field as
    // "invoice now", and a screen that shows the choice must not leave it implied.
    ...(invoicingOptionApplies ? { invoice_immediately: invoiceImmediately } : {}),
    // Same rule for `prorate`: the checkbox is visible, so the value it shows is sent
    // rather than left to the route's default (which is also true, but a screen that
    // renders a choice must post it).
    // Only the operator's own choice: untouched, the server applies the business rule for
    // the direction it computes, as the estimate did.
    ...(prorateToSend(prorateApplies, prorateChoice) !== undefined
      ? { prorate: prorateToSend(prorateApplies, prorateChoice) }
      : {}),
  };
  const scheduleMissingDate = applyIsScheduled && !effectiveApplyAt;
  // A scheduled edit carries the same three lists as an immediate one (POST …/schedule
  // stores all of them as of 2026-08-31), so ANY item work is schedulable — an
  // adds-only or removes-only edit included. What a schedule still cannot carry is the
  // non-item work on this screen: billing info, coupon, trial end. Those post
  // immediately whatever the apply mode, so a deferred edit needs at least one line.
  const scheduleMissingChanges =
    applyIsScheduled && changes.length === 0 && adds.length === 0 && removes.length === 0;
  /** Any LINE work at all — the three lists POST …/change and POST …/schedule both take. */
  const hasLineWork = changes.length > 0 || adds.length > 0 || removes.length > 0;
  /**
   * The deferred edit in words, in the same order and phrasing the server action reports
   * it back in — so the summary an operator approves and the message they land on after
   * the redirect describe the same edit.
   */
  const scheduledEditParts = [
    changes.length > 0 ? `${changes.length} line(s) changed` : null,
    removes.length > 0 ? `${removes.length} removed` : null,
    adds.length > 0 ? `${adds.length} added` : null,
  ].filter(Boolean) as string[];
  const dirty =
    changes.length > 0 ||
    adds.length > 0 ||
    removes.length > 0 ||
    hasSettingsChange ||
    Boolean(couponCode) ||
    Boolean(manualDiscount) ||
    removeApplied ||
    trialEndChanged ||
    endTrialNow;

  // Reactivation payload: the FULL desired line set (non-removed lines with a price).
  const reactItems = lines
    .filter((l) => !("removed" in l && l.removed) && l.price)
    .map((l) => {
      const price = priceById.get(l.price);
      const eff = effectiveUnitMinor(l);
      const overridable = price ? OVERRIDABLE_MODELS.has(price.model) : false;
      const sendOverride = overridable && eff !== (price?.amount_minor ?? 0);
      return {
        price: l.price,
        quantity: l.quantity || 1,
        ...(sendOverride ? { unit_price_minor: eff } : {}),
      };
    });
  const reactPayload: ReactivationPayload = {
    items: reactItems,
    ...(billingCyclesMode === "limited" && billingCyclesN
      ? { billing_cycles: Number(billingCyclesN) }
      : {}),
    ...(reactTrialEnd ? { trial_end: reactTrialEnd } : {}),
    charges_handling: chargesHandling,
    // Omitted means "continue when eligible", so only the override is sent.
    ...(reactTerm === "new" ? { term: "new" as const } : {}),
    // Applied before the fresh term is invoiced — the same pair `/change` carries.
    ...(couponCode ? { coupon_code: couponCode } : {}),
    ...(manualDiscount ? { manual_discount: manualDiscount } : {}),
    // `remaining_billing_cycles` is not one: reactivation takes `billing_cycles` instead.
    ...(settings.auto_collection !== undefined ||
    settings.po_number !== undefined ||
    settings.invoice_notes !== undefined
      ? {
          settings: {
            ...(settings.auto_collection !== undefined
              ? { auto_collection: settings.auto_collection }
              : {}),
            ...(settings.po_number !== undefined ? { po_number: settings.po_number } : {}),
            ...(settings.invoice_notes !== undefined
              ? { invoice_notes: settings.invoice_notes }
              : {}),
          },
        }
      : {}),
  };
  const hasPlanLine = Boolean(planLine);

  const [estimate, setEstimate] = React.useState<ChangeEstimate | null>(null);

  // ── Change options: business rules this change may override ────────────────
  // Each is shown only where it has an effect, preselected to the business rule, and sent
  // only when it differs, so an untouched screen leaves the rule in charge.
  const downgrading = policy?.direction === "downgrade";
  const planCreditsRule = downgrading
    ? changeRules.plan_credits.downgrade
    : changeRules.plan_credits.upgrade;
  const [chargeFailureChoice, setChargeFailureChoice] = useDefaultState(
    changeRules.on_charge_failure,
  );
  const [couponsChoice, setCouponsChoice] = useDefaultState(changeRules.coupons);
  const [creditChoice, setCreditChoice] = useDefaultState(changeRules.downgrade_credit);
  const [planCreditsChoice, setPlanCreditsChoice] = useDefaultState<
    "full" | "prorated" | "next_window"
  >(planCreditsRule);
  const [allowancesChoice, setAllowancesChoice] = useDefaultState(changeRules.allowances);
  /** Only a change applied now carries its own rules; a scheduled one follows the rules. */
  const changeNow = !reactivating && !applyIsScheduled && hasLineWork;
  const movesPlan = changes.some((c) => c.price && kindOf(c.price) === "plan");
  const showCoupons = changeNow && movesPlan && Boolean(keptDiscount?.coupon);
  const showCredit =
    changeNow &&
    (estimate?.refundable_credit_added_minor ?? 0) +
      (estimate?.refunded_to_payment_method_minor ?? 0) >
      0;
  const showChargeFailure =
    changeNow &&
    status !== "in_trial" &&
    invoiceImmediately &&
    effectiveAutoCollectOn &&
    (estimate?.amount_due_minor ?? 0) > 0;
  const showPlanCredits = changeNow && policy?.plan_credits != null;
  const showAllowances = changeNow && !downgrading && policy?.allowances != null;
  const changeOverrides: ChangeRuleOverrides = {
    ...(showChargeFailure && chargeFailureChoice !== changeRules.on_charge_failure
      ? { on_charge_failure: chargeFailureChoice }
      : {}),
    ...(showCoupons && couponsChoice !== changeRules.coupons ? { coupons: couponsChoice } : {}),
    ...(showCredit && creditChoice !== changeRules.downgrade_credit
      ? { downgrade_credit: creditChoice }
      : {}),
    // A downgrade cannot prorate plan credits; the route refuses it.
    ...(showPlanCredits &&
    planCreditsChoice !== planCreditsRule &&
    !(downgrading && planCreditsChoice === "prorated")
      ? { plan_credits: planCreditsChoice }
      : {}),
    ...(showAllowances && allowancesChoice !== changeRules.allowances
      ? { allowances: allowancesChoice }
      : {}),
  };
  /** The two that move money, so the estimate prices them too. */
  const sentCoupons = changeOverrides.coupons;
  const sentCredit = changeOverrides.downgrade_credit;

  /** The business's plan-change gate refuses this edit; the apply would 409. */
  const changeBlocked = !reactivating && hasLineWork ? (policy?.blocked ?? null) : null;
  // Every input the estimate is priced from: Save waits for the answer to THIS one.
  const editKey = changeEditKey(changes, adds, removes, [
    estimateChangeOption ?? "now",
    effectiveProrate ?? null,
    resetTermSent ?? null,
    sentCoupons ?? null,
    sentCredit ?? null,
  ]);
  /** False while the policy on screen may belong to an earlier edit. */
  const ready = policyReady({ hasLineWork, reactivating, answeredKey, editKey });

  const submitDisabled = reactivating
    ? !hasPlanLine || (billingCyclesMode === "limited" && !billingCyclesN)
    : !dirty ||
      Boolean(changeBlocked) ||
      !ready ||
      endTrialBlocked ||
      scheduleMissingDate ||
      scheduleMissingChanges ||
      mdValueInvalid ||
      !metadataValid;

  // ── Live estimate (modified lines + adds + removes) ────────────────────────
  // All three are previewed, because all three move money on apply: `/change`
  // prorates a modified line, `POST /items` charges the rest of the term for an add,
  // and `DELETE /items/:id` credits unused time for a remove.
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
  // Bumped when `/change` refuses a moved quote, so the rail prices the edit again.
  const [recheck, setRecheck] = React.useState(0);
  const [estimating, startEstimate] = React.useTransition();
  const changesKey = JSON.stringify(changes);
  const addsKey = JSON.stringify(adds);
  const removesKey = JSON.stringify(removes);
  React.useEffect(() => {
    // No live proration when reactivating a cancelled sub (no current term).
    if (
      reactivating ||
      (changes.length === 0 &&
        adds.length === 0 &&
        removes.length === 0 &&
        !couponCode &&
        !manualDiscount &&
        !removeApplied)
    ) {
      setEstimate(null);
      setEstimateError(null);
      setPolicy(null);
      setAnsweredKey(null);
      askedKeyRef.current = null;
      shapeKeyRef.current = null;
      return;
    }
    const askedKey = changeEditKey(
      JSON.parse(changesKey),
      JSON.parse(addsKey),
      JSON.parse(removesKey),
      [
        estimateChangeOption ?? "now",
        effectiveProrate ?? null,
        resetTermSent ?? null,
        sentCoupons ?? null,
        sentCredit ?? null,
      ],
    );
    const shapeKey = changeEditKey(
      JSON.parse(changesKey),
      JSON.parse(addsKey),
      JSON.parse(removesKey),
      estimateChangeOption ?? "now",
    );
    // New items or a new timing: the last policy may be for the other direction, and the
    // last figures for the other timing.
    if (shapeKeyRef.current !== shapeKey) {
      setPolicy(null);
      setEstimate(null);
    }
    shapeKeyRef.current = shapeKey;
    askedKeyRef.current = askedKey;
    const t = setTimeout(() => {
      startEstimate(async () => {
        const res = await estimateSubscriptionChangeAction(
          biz,
          sub,
          JSON.parse(changesKey),
          resetTermSent,
          JSON.parse(addsKey),
          JSON.parse(removesKey),
          effectiveProrate,
          couponCode || undefined,
          manualDiscount ? { type: manualDiscount.type, value: manualDiscount.value } : undefined,
          removeApplied,
          estimateChangeOption,
          { coupons: sentCoupons, downgrade_credit: sentCredit },
        );
        if (askedKeyRef.current !== askedKey) return;
        if (res.ok) {
          setEstimate(res.estimate);
          setEstimateError(null);
          setPolicy(res.estimate.change_policy ?? null);
        } else {
          setEstimate(null);
          setEstimateError(res.error);
          setPolicy(null);
        }
        setAnsweredKey(askedKey);
      });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // ⚠ `couponKey`/`manualDiscountKey` are in here because the effect is what makes the
    // rail re-fetch. Threading the two values through the ACTION but leaving them out of
    // this list would look correct in every diff and still never re-estimate: the operator
    // adds a coupon, nothing re-runs, and the stale figure stays on screen.
    // Serialised rather than passed by reference — `manualDiscount` is a fresh object
    // literal on every render, which would re-fetch on each keystroke of every field.
  }, [
    biz,
    sub,
    changesKey,
    addsKey,
    removesKey,
    resetTermSent,
    effectiveProrate,
    couponKey,
    manualDiscountKey,
    removeApplied,
    estimateChangeOption,
    sentCoupons,
    sentCredit,
    recheck,
  ]);

  // ── Live estimate for a REACTIVATION ──────────────────────────────────────────
  // A separate endpoint and separate state, because a reactivation is not a change:
  // `estimateChange` prorates against a CURRENT TERM and a cancelled subscription has none,
  // so `…/estimate` refuses this screen outright. `…/reactivate_estimate` prices the fresh
  // full term the reactivation books, through the same rating, tax vector and credit draw
  // `billSubscriptionPeriod` will use.
  //
  // Until this existed the dialog summed `unit_price × quantity` over its own rows and
  // labelled the result "Chargeable immediately" (#56). On an Indian customer that is short
  // by CGST + SGST and long by whatever account credit the invoice spends: ₹10,998.00 shown
  // where ₹12,977.64 was invoiced and ₹3,316.51 collected.
  const [reactEstimate, setReactEstimate] = React.useState<ChangeEstimate | null>(null);
  const [reactEstimateError, setReactEstimateError] = React.useState<string | null>(null);
  const [reactEstimating, startReactEstimate] = React.useTransition();
  const reactItemsKey = JSON.stringify(reactItems);
  React.useEffect(() => {
    if (!reactivating) {
      setReactEstimate(null);
      setReactEstimateError(null);
      return;
    }
    const items = JSON.parse(reactItemsKey) as ReactivationPayload["items"];
    if (items.length === 0) {
      setReactEstimate(null);
      setReactEstimateError(null);
      return;
    }
    const t = setTimeout(() => {
      startReactEstimate(async () => {
        // `trial_end` is sent because it CHANGES the money (nothing is collected today).
        // `billing_cycles` and `charges_handling` are not: one caps the second cycle
        // onward, the other decides whether this composition is invoiced or parked.
        const res = await estimateSubscriptionReactivationAction(
          biz,
          sub,
          items,
          reactTrialEnd || undefined,
          couponCode || undefined,
          manualDiscount,
          reactTerm === "new" ? "new" : undefined,
          chargeFailure !== reactivationChargeFailure ? chargeFailure : undefined,
        );
        if (res.ok) {
          setReactEstimate(res.estimate);
          setReactEstimateError(null);
        } else {
          setReactEstimate(null);
          setReactEstimateError(res.error);
        }
      });
    }, 400);
    return () => clearTimeout(t);
    // `reactItemsKey` is the serialised payload rather than the array: `reactItems` is a
    // fresh literal on every render and would re-fetch on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialised pair below
  }, [
    biz,
    sub,
    reactivating,
    reactItemsKey,
    reactTrialEnd,
    couponKey,
    manualDiscountKey,
    reactTerm,
    chargeFailure,
    reactivationChargeFailure,
  ]);

  /**
   * WHETHER THE REACTIVATION'S MONEY MOVES TODAY. A trial defers the whole first bill to
   * the conversion, and `add_to_unbilled_charges` parks the composition as an unbilled
   * charge for the next invoice to fold in — in both cases the engine's `amount_due_minor`
   * is 0 or not-yet-raised, so it is not the figure to headline. Those two branches keep
   * the wording they already had.
   */
  /**
   * A dunning cancellation inside its term with the same lines continues that term: no
   * invoice, whatever the invoicing option says. The engine decides; this only reads it.
   */
  const reactInTerm =
    reactivating && !reactTrialEnd ? (reactEstimate?.in_term_reactivation ?? null) : null;
  const reactDeferred =
    Boolean(reactTrialEnd) || (!reactInTerm && chargesHandling === "add_to_unbilled_charges");
  /** A charge is taken on apply, so the failed-charge choice has an effect. */
  const reactChargesNow =
    reactivating &&
    effectiveAutoCollectOn &&
    (reactInTerm
      ? reactInTerm.invoice.outstanding_minor > 0
      : !reactDeferred && (reactEstimate?.amount_due_minor ?? 1) > 0);
  /** The engine's answer for this reactivation, or null while it has not answered. */
  const reactMoney = reactivating && !reactDeferred && !reactInTerm ? reactEstimate : null;
  /**
   * The footer rows, EVERY ONE straight off the estimate. Nothing here is arithmetic on the
   * form's own rows — the single derivation is splitting the engine's `discount_minor` into
   * its coupon and promotional halves, the same partition the change branch makes (the
   * promotional slice is reported separately because it renders ABOVE the tax rows: it
   * shrank the taxable base).
   */
  const reactBalanceCreditsMinor = reactMoney?.credits_applied_minor;
  const reactPromotionalDiscountMinor = reactMoney?.promotional_discount_minor;
  const reactCouponDiscountMinor = reactMoney
    ? Math.max(0, reactMoney.discount_minor - (reactMoney.promotional_discount_minor ?? 0))
    : undefined;

  const [breakdownOpen, setBreakdownOpen] = React.useState(false);
  const chargesMinor = estimate
    ? estimate.lines.filter((l) => l.amount_minor > 0).reduce((s, l) => s + l.amount_minor, 0)
    : 0;
  const creditsMinor = estimate
    ? -estimate.lines.filter((l) => l.amount_minor < 0).reduce((s, l) => s + l.amount_minor, 0)
    : 0;
  const netMinor = estimate ? estimate.total_minor : 0;
  // POST-tax buckets only. The promotional bucket is applied PRE-tax and arrives as its
  // own field — the estimate stopped folding it in here when the invoice document stopped
  // doing so (30fcbd6), because it is already netted out of `total_minor`.
  const balanceCreditsMinor = estimate?.credits_applied_minor ?? 0;
  const promotionalDiscountMinor = estimate?.promotional_discount_minor ?? 0;
  // `discount_minor` is EVERY discount off the subtotal — coupons and manual discounts
  // PLUS the promotional slice, which is reported separately and rendered as its own row.
  // The remainder is the coupon/manual part; without it the footer lost the difference and
  // stopped reconciling the moment `estimateChange` started pricing discounts at all.
  const couponDiscountMinor = Math.max(
    0,
    (estimate?.discount_minor ?? 0) - promotionalDiscountMinor,
  );
  const amountDueMinor = estimate?.amount_due_minor ?? Math.max(netMinor, 0);
  // ── THE TWO DOCUMENTS A CHANGE RAISES ────────────────────────────────────────
  // An invoice for the charges, and a credit note for the unused time that reverses the
  // tax originally charged on it. They are separate documents with separate totals, and
  // the footer below states both rather than pretending one subtotal and one tax row can
  // describe them: `chargesMinor − creditsMinor + tax_minor` is NOT the amount due, and
  // reading it that way is what quoted "₹7,234.24 chargeable immediately" for a downgrade
  // that owed ₹887.36 back (the credit note's ₹8,121.60 of tax was in neither term).
  // Prefer the ENGINE's figure; the local reconstruction stays as the fallback for an
  // estimate produced before `invoice_total_minor` existed.
  const invoiceTotalMinor =
    estimate?.invoice_total_minor ??
    chargesMinor - couponDiscountMinor - promotionalDiscountMinor + (estimate?.tax_minor ?? 0);
  const creditNoteMinor = estimate?.credit_note_total_minor ?? 0;
  // ── THE SHAPE, 2026-08-31 ────────────────────────────────────────────────────
  // The ladder subtracts ONE credit figure: `credits_applied`, the slice that offsets this
  // invoice. The gross note and every other destination moved into the Credits prose.
  //
  // What this replaced: the note stated GROSS, then `+ creditToOpenInvoices` added back so
  // the column could reach "Amount due". Correct arithmetic, two documents in one column.
  //
  // ⚠ `credit_applied_to_this_invoice_minor`, never `creditNoteMinor − creditToOpenInvoices`
  // — that subtraction ignores the balance, bucket and stranded legs and is right only on
  // the shape this was debugged against.
  const creditAppliedHereMinor = estimate?.credit_applied_to_this_invoice_minor ?? 0;
  const creditNarrative = creditNarrativeFromEstimate(estimate ?? {});
  /** What that note exceeds the invoice by — it goes back on the balance. */
  const refundableAddedMinor = estimate?.refundable_credit_added_minor ?? 0;
  // `creditToOpenInvoicesMinor` was read here for the ladder's `+ Cleared unpaid invoices`
  // row. That row is gone and the slice is now one of the Credits sentences, typed, straight
  // from `credit_destinations` — so the scalar has no reader left and is not kept "in case".
  /** The Credits section, one sentence per non-zero leg. Empty without an estimate, which is
   *  also the only state where there is no currency to format in. */
  const creditSentences = estimate
    ? creditLegSentences(creditNarrative, (m) => money(m, estimate.currency), {
        audience: "operator",
        fmtWhen: (iso) => fmtDateTime(iso, tz),
      })
    : [];
  // IN TRIAL the backend charges nothing (nothing has been billed, so there is no
  // term to prorate against) and returns the trial-end bill instead — see
  // `billsAtTrialEnd` in src/modules/subscriptions/proration.ts. The rail must say
  // exactly that: showing "chargeable immediately" here promised a charge the
  // /change call does not make.
  // Strictly the API's own answer, so the panel can never claim a settlement the
  // /change call will not make. `inTrial` (below) is the server-rendered status, used
  // only for the descriptive copy that must render before any estimate exists
  // (add/remove-only edits never call the estimate endpoint).
  const trialEndAtIso = estimate?.due_at_trial_end ?? null;
  const billedAtTrialEnd = Boolean(trialEndAtIso);
  const inTrial = status === "in_trial";
  /**
   * What ending the trial NOW puts on the card today. Two sources, because the trial-end
   * invoice has two possible compositions: with item edits, the change estimate already
   * prices the post-change composition the trial-end invoice will raise (`due_at_trial_end`,
   * total = `netMinor`) and that bill simply falls due today instead; with no edits, the
   * server-fetched renewal estimate IS that invoice. Null only when the estimate failed —
   * then the screen states the mechanism and quotes no number.
   */
  /**
   * A pure trial-date move: no lines touched, no coupon, no discount. Nothing is charged
   * and nothing is estimated (the estimate endpoint is never called), so the dialog would
   * otherwise headline "$0.00 — Chargeable immediately", which reads as a charge of zero
   * rather than as "the bill just moved".
   */
  const trialDateOnlyChange =
    trialEndChanged &&
    !endTrialNow &&
    changes.length === 0 &&
    adds.length === 0 &&
    removes.length === 0 &&
    !couponCode &&
    !manualDiscount &&
    !removeApplied;
  const endTrialDueMinor = endTrialBlocked
    ? 0
    : endTrialNow
      ? billedAtTrialEnd
        ? netMinor
        : (firstTerm?.amount_due_minor ?? firstTerm?.total_minor ?? null)
      : null;

  /**
   * Whether a price is billed ON THE FIRST INVOICE OF A TERM at all.
   *
   * METERED ITEMS ARE NOT: usage is rated in arrears, so a `usage`-model price (and a
   * `percentage` price with a usage aggregation) contributes nothing to the term's opening
   * invoice — `estimateFreshTermMoney` skips exactly these, and so does the booking.
   *
   * ⚠ Measured over CDP, and it is NOT hypothetical: on one subscription the
   * rail's own sum read **$35.01** while the engine answered **$35.00**, because the
   * subscription carries a `per-1k-calls` metered line at 1 minor unit which the
   * reactivation invoice will never bill. A cent here; on a real metered plan it is the
   * per-unit rate × a quantity that means nothing.
   *
   * This is a one-line PREDICATE, not a second money calculator, and it is used ONLY for
   * the pre-estimate fallback below — every figure the screen states once the engine has
   * answered comes from the engine. It is here rather than left wrong because a "subtotal"
   * containing a line no invoice will carry is not a subtotal.
   */
  const billsUpFront = (priceId: string): boolean => {
    const p = priceById.get(priceId);
    if (!p) return true;
    if (p.metered != null) return !p.metered;
    return !(
      p.model === "usage" ||
      ((p.model === "percentage" || p.model === "graduated_percentage") &&
        p.usage_aggregation != null)
    );
  };

  // Σ each resulting (non-removed) line's unit price × quantity — PRE-TAX, PRE-COUPON and
  // PRE-CREDIT.
  //
  // ⚠ NEVER THE HEADLINE. It was, on the reactivation branch, under the label "Chargeable
  // immediately" — which is #56: a true value (the subtotal) under a false description
  // (the amount about to be charged). `reactMoney.amount_due_minor` is the charge; this is
  // the SUBTOTAL, and it is rendered only while the estimate has not answered, under a
  // label that says so, with no tax or credit rows beside it. Showing fewer rows beats
  // inventing them. Everything else must use `renewalDueMinor` below.
  const reactivationTermMinor = lines
    .filter((l) => !(l.kind === "existing" && l.removed) && l.price && billsUpFront(l.price))
    .reduce((sum, l) => sum + effectiveUnitMinor(l) * (l.quantity || 1), 0);
  // The engine's own answer for "Next invoice of …": the post-change composition with
  // tax and coupons in, net of the credit this change hands forward.
  //
  // This sentence used to quote `reactivationTermMinor`. On an 18%-GST subscription that
  // understated the renewal by the entire tax amount — ₹76,892 where the true figure was
  // ₹89,845.20 — which is the exact defect `estimateRenewal`'s docstring was written
  // about ("a parallel calculator is how the dashboard came to show a customer's
  // upcoming payment as the bare sum of unit_price × quantity"), re-committed one screen
  // over. Null when there is no next term to bill, in which case say nothing.
  const nextRenewal = estimate?.next_renewal ?? null;

  /**
   * ONE PLACE THAT DECIDES WHAT THE REACTIVATION'S MONEY IS CALLED, so the headline, the
   * rail's ladder and the confirm dialog's footer cannot say three things about one
   * reactivation. Each branch names the figure it states, and every figure is the
   * engine's.
   *
   *   invoice now   → `amount_due_minor`  — cash today, after tax and account credit.
   *   into a trial  → `total_minor`       — nothing today; this is what the conversion bills.
   *   to unbilled   → `subtotal_minor`    — an unbilled charge is stored PRE-TAX and
   *                                         un-netted; tax and credit are applied by the
   *                                         invoice that folds it in, at that invoice's
   *                                         place of supply. Quoting a taxed, credit-netted
   *                                         figure here names a number no document carries.
   *
   * With no estimate in hand, the SUBTOTAL, called a subtotal, and no tax or credit row
   * beside it. #56 was this box stating a subtotal under "Invoiced now" / "Chargeable
   * immediately"; the number was right and the description was not.
   */
  const reactSummary: {
    minor: number;
    label: string;
    /** Tax rows belong on the two branches whose figure is post-tax; never on `unbilled`. */
    taxMinor?: number;
    taxLines?: Array<{ label: string; amount_minor: number }>;
    /** Present only where tax rows are, so the column reads subtotal → tax → figure. */
    subtotalMinor?: number;
  } = reactTrialEnd
    ? reactEstimate
      ? {
          minor: reactEstimate.total_minor,
          label: "Billed at trial end",
          taxMinor: reactEstimate.tax_minor,
          taxLines: reactEstimate.tax_lines,
          subtotalMinor: reactEstimate.subtotal_minor,
        }
      : { minor: reactivationTermMinor, label: "Subtotal" }
    : reactInTerm
      ? { minor: reactEstimate?.amount_due_minor ?? 0, label: "Amount due" }
      : chargesHandling === "add_to_unbilled_charges"
        ? {
            minor: reactEstimate?.subtotal_minor ?? reactivationTermMinor,
            label: "Pre-tax subtotal",
          }
        : reactMoney
          ? {
              minor: reactMoney.amount_due_minor ?? reactMoney.total_minor,
              label: "Amount due",
              taxMinor: reactMoney.tax_minor,
              taxLines: reactMoney.tax_lines,
            }
          : { minor: reactivationTermMinor, label: "Subtotal" };

  /**
   * THE REACTIVATION RAIL'S LADDER — the in-page box #56 was actually measured on. It
   * printed exactly ONE row, `Invoiced now ₹10,998.00`, under the sentence "Full new-term
   * price of every line above": the pre-tax sum of the lines, labelled as the amount about
   * to be charged. The real invoice was ₹12,977.64 and ₹3,316.51 was collected.
   *
   * Every row below is a field the engine returned — no client-side tax, no netting by
   * hand. The order is the invoice's own: promotional credit shrank the taxable base, so it
   * sits ABOVE the tax rows; refundable/excess balance is applied to the taxed total, so it
   * sits BELOW them. Same shape and same labels as the confirm dialog's footer, so the two
   * surfaces cannot read differently for one reactivation.
   */
  const reactLadder: Array<{
    label: string;
    amountMinor: number;
    kind?: "muted" | "credit" | "total";
  }> = reactMoney
    ? [
        { label: "Subtotal", amountMinor: reactMoney.subtotal_minor, kind: "muted" },
        ...((reactCouponDiscountMinor ?? 0) > 0
          ? [
              {
                label: "Discounts",
                amountMinor: reactCouponDiscountMinor!,
                kind: "credit" as const,
              },
            ]
          : []),
        ...((reactPromotionalDiscountMinor ?? 0) > 0
          ? [
              {
                label: "Promotional credits",
                amountMinor: reactPromotionalDiscountMinor!,
                kind: "credit" as const,
              },
            ]
          : []),
        // NAMED components — `CGST (9.00%)` + `SGST/UTGST (9.00%)`. The single "Tax" row is
        // the fallback for a jurisdiction whose vector is one component, never a collapse
        // of several: the buyer meets the split on the document and has to be able to tie
        // it back to this quote.
        ...((reactSummary.taxLines ?? []).length > 0
          ? reactSummary.taxLines!.map((t) => ({
              label: t.label,
              amountMinor: t.amount_minor,
              kind: "muted" as const,
            }))
          : (reactSummary.taxMinor ?? 0) > 0
            ? [{ label: "Tax", amountMinor: reactSummary.taxMinor!, kind: "muted" as const }]
            : []),
        ...((reactBalanceCreditsMinor ?? 0) > 0
          ? [
              {
                label: "Account credits applied",
                amountMinor: reactBalanceCreditsMinor!,
                kind: "credit" as const,
              },
            ]
          : []),
        {
          label: "Amount due",
          amountMinor: reactMoney.amount_due_minor ?? reactMoney.total_minor,
          kind: "total",
        },
      ]
    : reactInTerm
      ? [
          {
            label: `Open on ${reactInTerm.invoice.number ?? reactInTerm.invoice.id}`,
            amountMinor: reactInTerm.invoice.outstanding_minor,
            kind: "muted",
          },
          { label: reactSummary.label, amountMinor: reactSummary.minor, kind: "total" },
        ]
      : [
          // The DEFERRED branches, and the no-estimate fallback: `reactSummary` already
          // decided what the one figure is and what it is called. Tax rows come with it on
          // the trial branch (its figure is post-tax) and never on the unbilled one.
          ...(reactSummary.subtotalMinor != null
            ? [
                {
                  label: "Subtotal",
                  amountMinor: reactSummary.subtotalMinor,
                  kind: "muted" as const,
                },
              ]
            : []),
          ...(reactSummary.taxLines ?? []).map((t) => ({
            label: t.label,
            amountMinor: t.amount_minor,
            kind: "muted" as const,
          })),
          { label: reactSummary.label, amountMinor: reactSummary.minor, kind: "total" as const },
        ];

  // ── Confirmation summary ────────────────────────────────────────────────────
  const formRef = React.useRef<HTMLFormElement>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // The estimate on screen, for an immediate change: `/change` books exactly its amounts.
  // Only where the credit moves with time (not in a trial, not scheduled).
  const quoteFields =
    invoicingOptionApplies && answeredKey === editKey && estimate?.priced_at && estimate.quote
      ? { priced_at: estimate.priced_at, quote: estimate.quote }
      : {};
  const router = useRouter();
  const [submitting, startSubmit] = React.useTransition();
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const applyErrorTitle = reactivating
    ? "We could not reactivate the subscription"
    : "We could not apply the change";
  // onSubmit, not `action`: React resets a form after an action, and a refused edit must
  // leave every field of this page exactly as the operator left it.
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSubmit(async () => {
      const apply = reactivating
        ? applySubscriptionReactivationAction
        : applySubscriptionChangeAction;
      const r = await apply(null, fd);
      setConfirmOpen(false);
      if (!r.ok && r.errors?.quote) {
        setApplyError(r.errors.quote);
        toast.error(`${applyErrorTitle}.`);
        setRecheck((n) => n + 1);
        return;
      }
      if (!r.ok) {
        // The banner holds the reason; the toast only says that it failed.
        setApplyError(r.message ?? `${applyErrorTitle}.`);
        toast.error(`${applyErrorTitle}.`);
        return;
      }
      setApplyError(null);
      if (r.message) (r.warning ? toast.warning : toast.success)(r.message);
      if (r.redirectTo) router.push(r.redirectTo);
    });
  };
  const nameOfPrice = (priceId: string): string => {
    const prod = productOfPrice(priceId);
    const price = priceById.get(priceId);
    const freq = price?.interval ? ` ${INTERVAL_LABEL[price.interval] ?? price.interval}` : "";
    return `${prod?.name ?? priceId}${freq}`;
  };
  // Diff rows (change mode): MODIFIED / ADDED / REMOVED per line.
  const discountName = (d: Discount) =>
    d.source === "manual" ? "Manual discount" : (d.coupon ?? d.code ?? "Coupon");
  // The discount half of the edit, so the confirm states it before it is applied.
  const discountDiffRows: SummaryDiffRow[] = [
    ...(removeApplied && appliedDiscount
      ? [{ kind: "removed" as const, text: <>Discount {discountName(appliedDiscount)}</> }]
      : []),
    ...(couponCode ? [{ kind: "added" as const, text: <>Coupon {couponCode}</> }] : []),
  ];
  const lineDiffRows: SummaryDiffRow[] = lines.flatMap((l): SummaryDiffRow[] => {
    if (l.kind === "existing") {
      if (l.removed) return [{ kind: "removed" as const, text: nameOfPrice(l.originalPrice) }];
      if (l.price !== l.originalPrice) {
        const label = kindOf(l.price) === "plan" ? "Plan" : "Addon";
        return [
          {
            kind: "modified" as const,
            text: (
              <>
                <b>{label}</b> changed from {nameOfPrice(l.originalPrice)} to {nameOfPrice(l.price)}
              </>
            ),
          },
        ];
      }
      if (l.quantity !== l.originalQuantity) {
        return [
          {
            kind: "modified" as const,
            text: (
              <>
                {nameOfPrice(l.price)} quantity {l.originalQuantity} → {l.quantity}
              </>
            ),
          },
        ];
      }
      if (l.unit_price_minor !== "")
        return [
          {
            kind: "modified" as const,
            text: (
              <>
                {nameOfPrice(l.price)} price set to {money(Number(l.unit_price_minor), currency)}
              </>
            ),
          },
        ];
      return [];
    }
    return l.price ? [{ kind: "added" as const, text: nameOfPrice(l.price) }] : [];
  });
  const diffRows: SummaryDiffRow[] = [...lineDiffRows, ...discountDiffRows];

  // Charge lines for the dialog.
  const scheduled = applyIsScheduled;
  // The API describes an estimate line with the price's INTERNAL HANDLE
  // (`Remaining time on gs-business-v202506-INR-Monthly ×1`). The formatter swaps it
  // for the display name and lifts the `×N` into its own Units column — see
  // lib/estimate-lines.ts.
  const lineFormatter = React.useMemo(
    () => makeEstimateLineFormatter(priceById, productById),
    [priceById, productById],
  );
  // Charges only. A negative estimate line is a CREDIT and gets its own signed footer
  // row — listed among the charges it reads as a discounted item, and it silently made
  // the footer total disagree with the headline.
  //
  // `units` / `unitPriceMinor` are the two extra columns, which `SummaryChargeLine`
  // has always supported but only the reactivation path filled in. No `period`: the
  // estimate reports no service window, and a change and an add/remove prorate from
  // DIFFERENT boundaries (`prorationBoundary` vs `prorationWindowStart`, see
  // estimate.ts) — a window derived here would be a guess, and on some lines a wrong one.
  const changeCharges: SummaryChargeLine[] = estimate
    ? estimate.lines.filter((l) => l.amount_minor > 0).map((l) => lineFormatter.view(l))
    : [];
  // The RENEWAL pane's rows. Same formatter as the immediate lines — `next_renewal.lines`
  // arrive in the `<label> ×N` shape `estimate-lines.ts` already parses, so the units lift
  // into their own column exactly as they do above, and no handle leaks onto the screen.
  const renewalCharges: SummaryChargeLine[] = nextRenewal
    ? nextRenewal.lines.map((l) => lineFormatter.view(l))
    : [];
  // The reactivation's charge rows. The ENGINE's lines when it has answered — same
  // formatter as the change and renewal panes, which turns `flat (handle) ×2` into the
  // product's display name with the units lifted into their own column — falling back to
  // the form's own rows while the estimate is in flight. The fallback restates the
  // operator's input rather than predicting an outcome, and the footer beside it carries
  // no tax or credit rows in that state.
  const reactCharges: SummaryChargeLine[] = reactEstimate
    ? reactEstimate.lines.filter((l) => l.amount_minor !== 0).map((l) => lineFormatter.view(l))
    : lines
        .filter((l) => !(l.kind === "existing" && l.removed) && l.price && billsUpFront(l.price))
        .map((l) => ({
          description: nameOfPrice(l.price),
          units: isQuantityBased(priceById.get(l.price)?.model) ? l.quantity || 1 : null,
          unitPriceMinor: effectiveUnitMinor(l),
          amountMinor: effectiveUnitMinor(l) * (l.quantity || 1),
        }));
  // Ending the trial with no item edits: the change estimate is never called (nothing to
  // prorate), so ITEMISE the first-term invoice from the renewal estimate instead of
  // showing a bare headline. Its Σ + tax reconciles with `summaryTotalMinor` by
  // construction, since both come from that one estimate.
  const firstTermCharges: SummaryChargeLine[] =
    endTrialNow && !endTrialBlocked && changeCharges.length === 0 && firstTerm
      ? firstTerm.lines.map((l) => ({ description: l.description, amountMinor: l.amount_minor }))
      : [];
  const toStatusResolved = reactivating
    ? reactTrialEnd
      ? "in_trial"
      : "active"
    : endTrialBlocked
      ? status
      : endTrialNow
        ? "active"
        : status;
  /**
   * DEFERRED branch: the amount that lands in unbilled charges is the estimate's
   * SUBTOTAL — the proration lines themselves. Not `total_minor` and not
   * `amount_due_minor`: an unbilled charge is stored pre-tax and un-netted, and tax,
   * coupons and the customer's credit balances are applied by the renewal invoice
   * that folds it in (invoicing/service.ts). Quoting the taxed, credit-netted figure
   * here would name a number no document will ever carry.
   */
  const deferredBookedMinor = estimate?.subtotal_minor ?? 0;
  /**
   * THIS CHANGE HANDS MONEY BACK. Not "nothing happens" and not a charge — the third
   * outcome, and the one the screen had no way to say: `amount_due_minor` is 0 and
   * `total_minor` is negative, so the headline rendered "₹0.00 · Chargeable immediately",
   * which is true and answers nothing.
   *
   * So the headline re-points at the RENEWAL for exactly this case ("₹89,845.20
   * Chargeable on renewal") and states the credit underneath, because the next thing the
   * operator will be asked is what the customer now pays.
   */
  const netCreditNow =
    !reactivating &&
    !scheduled &&
    !billedAtTrialEnd &&
    !deferChargesToUnbilled &&
    estimate != null &&
    netMinor < 0;
  const headlineMinor =
    endTrialNow && endTrialDueMinor != null
      ? endTrialDueMinor
      : reactivating
        ? // A trial collects nothing today, so the headline is 0 and the label names the
          // figure and the date — the same shape the in-trial CHANGE branch uses. The two
          // other branches headline `reactSummary.minor`, which the footer also lands on.
          reactTrialEnd
          ? 0
          : reactSummary.minor
        : scheduled || billedAtTrialEnd
          ? 0
          : deferChargesToUnbilled
            ? deferredBookedMinor
            : // A credit collects nothing today, so quote what the customer is next asked for.
              netCreditNow && nextRenewal
              ? nextRenewal.amount_due_minor
              : amountDueMinor;
  const headlineLabel = trialDateOnlyChange
    ? `Nothing due now. We raise the first invoice at the new trial end (${fmtDate(trialEndAt, tz)})`
    : endTrialBlocked
      ? "Blocked. The customer has no payment method on file, and this subscription auto-collects"
      : endTrialNow
        ? endTrialDueMinor == null
          ? "First term invoiced today. We could not preview the amount"
          : effectiveAutoCollectOn
            ? "Chargeable immediately: first term"
            : // Auto-collection off is the send-invoice model: the first term is INVOICED
              // today, nothing is taken from a card.
              "Invoiced today: first term, sent instead of charged"
        : reactivating
          ? reactTrialEnd
            ? // NAME THE FIGURE AND THE DATE. "Charges on activation (trial)" over ₹0.00
              // is true and answers nothing — the operator's next question is what the
              // conversion will bill, and the engine has just answered it.
              reactEstimate
              ? `Nothing due now. We bill ${money(reactSummary.minor, currency)} when the trial ends (${fmtDate(reactTrialEnd, tz)})`
              : `Nothing due now. We raise the first invoice at the trial end (${fmtDate(reactTrialEnd, tz)})`
            : reactInTerm
              ? reactInTerm.collects_now
                ? `We collect the open balance of invoice ${reactInTerm.invoice.number ?? reactInTerm.invoice.id} now. We raise no new invoice`
                : "Nothing due now. The current term continues and we raise no new invoice"
              : chargesHandling === "add_to_unbilled_charges"
                ? "Added to unbilled charges. We charge nothing today"
                : reactMoney
                  ? // Credit can cover the whole bill. "Chargeable immediately ₹0.00" is
                    // true and says nothing; the operator needs to know the money came out
                    // of the customer's balance.
                    (reactMoney.amount_due_minor ?? 0) === 0 && reactMoney.total_minor > 0
                    ? "Covered in full by the customer's account credit. We charge nothing"
                    : effectiveAutoCollectOn
                      ? "Chargeable immediately"
                      : // Auto-collection off is the send-invoice model.
                        "Invoiced today: sent instead of charged"
                  : // NO ESTIMATE YET. The number on screen is the pre-tax subtotal, so the
                    // label says exactly that instead of promising it is the charge.
                    reactEstimateError
                    ? `Subtotal of the lines above. We could not preview the taxed total (${reactEstimateError})`
                    : "Subtotal of the lines above. Previewing tax and account credit…"
          : scheduled
            ? `Scheduled for ${
                effectiveApplyAt
                  ? fmtDateTime(effectiveApplyAt, tz)
                  : applyWhen === "end_of_term"
                    ? termEndNoun
                    : "the selected date"
              }. No immediate charge`
            : billedAtTrialEnd
              ? `Nothing due now. We bill ${money(netMinor, estimate!.currency)} at trial end (${fmtDate(trialEndAtIso, tz)})`
              : deferChargesToUnbilled
                ? "Added to unbilled charges. We charge nothing today"
                : // Wording for a change that credits: it names the RENEWAL, because
                  // nothing is collectible today and that is the next real charge.
                  netCreditNow
                  ? nextRenewal
                    ? // The label for this case: the card reads "₹89,845.20 INR / Chargeable
                      // on renewal", with the credit stated as its own line underneath rather
                      // than appended to the label.
                      "Chargeable on renewal"
                    : "Nothing due today. This change credits the customer"
                  : "Chargeable immediately";

  /** Nothing leaves the customer's card on apply — a trial change, a deferred apply, a
   *  change whose proration is queued as unbilled charges, or one that nets to a CREDIT.
   *  Drives tone and glyph only: money coming back must not wear the warning colour and
   *  an "!" that says something needs attention. */
  const nothingDueNow =
    trialDateOnlyChange ||
    netCreditNow ||
    (!endTrialNow && (billedAtTrialEnd || scheduled || deferChargesToUnbilled));

  // Footer reconciliation. The headline states the amount that actually moves, so the
  // footer must land on the SAME number: when we hold an estimate we hand the dialog its
  // authoritative total rather than let it re-sum the lines. Credits are passed only for
  // an immediate change, where they mean "money coming back now" — on a trial change
  // nothing moves, and on a reactivation the caller has no estimate at all.
  /** Whether the confirm dialog should state the credit NOTE (tax included) rather than
   *  the pre-tax credit lines — i.e. whether this apply actually issues one. */
  const showCreditNote =
    !reactivating &&
    !scheduled &&
    !billedAtTrialEnd &&
    !deferChargesToUnbilled &&
    creditNoteMinor > 0;
  const immediateChange = !reactivating && !scheduled;
  const summaryCreditsMinor = immediateChange && !billedAtTrialEnd ? creditsMinor : undefined;
  // Account credits are money spent AT COLLECTION. Deferring collects nothing now, so
  // the balance is untouched — the renewal invoice draws it then, against whatever the
  // balance is at that point. Showing today's draw would be a promise about a future
  // document.
  const summaryBalanceCreditsMinor =
    immediateChange && !billedAtTrialEnd && !deferChargesToUnbilled
      ? balanceCreditsMinor
      : undefined;
  // Same gating: the promotional draw is made by the invoice this apply raises, so a
  // deferred or trial-end change has not spent it either.
  const summaryPromotionalDiscountMinor =
    immediateChange && !billedAtTrialEnd && !deferChargesToUnbilled
      ? promotionalDiscountMinor
      : undefined;
  const summaryTotalMinor = reactivating
    ? // A REACTIVATION reconciles too, and its footer lands on the same figure the rail's
      // ladder does — both read `reactSummary`, so the two surfaces cannot disagree, and
      // neither can fall back to the dialog's own Σ-of-lines (which carries no tax, no
      // credit, and on a deferred branch is not the figure at all).
      reactSummary.minor
    : endTrialNow
      ? (endTrialDueMinor ?? undefined)
      : !immediateChange
        ? undefined
        : billedAtTrialEnd
          ? netMinor
          : deferChargesToUnbilled
            ? deferredBookedMinor
            : amountDueMinor;
  const summaryTotalLabel = reactivating
    ? reactSummary.label
    : endTrialNow
      ? "Amount due today"
      : !immediateChange
        ? "Total"
        : billedAtTrialEnd
          ? "Billed at trial end"
          : deferChargesToUnbilled
            ? "Added to unbilled charges"
            : "Amount due";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upd = (i: number, patch: Record<string, any>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? ({ ...l, ...patch } as Line) : l)));
  // `addLine` (a price-LESS new row, for the operator to fill from a row dropdown) is
  // gone with the row dropdowns: every add now arrives from the catalog modal already
  // resolved to a price, so no line on this screen is ever priceless.
  const dropNewLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  // ─── Grouping + per-slot dropdown options ────────────────────────────────────
  /** Which section a line renders in: existing lines follow their (original) price kind. */
  const slotOf = (l: Line): "plan" | "addon" | "charge" => {
    if (l.kind === "new") return l.slot;
    const k = kindOf(l.originalPrice) ?? kindOf(l.price);
    return k === "plan" || k === "charge" ? k : "addon";
  };
  const indexed = lines.map((l, i) => ({ l, i }));
  const planRows = indexed.filter(({ l }) => slotOf(l) === "plan");
  const addonRows = indexed.filter(({ l }) => slotOf(l) === "addon");
  const chargeRows = indexed.filter(({ l }) => slotOf(l) === "charge");

  /**
   * Lines whose product belongs to a DIFFERENT group than the filter — which is the
   * normal intermediate state of a cross-group move, and the one real decision the
   * group filter forces.
   *
   * They are LEFT IN PLACE and warned about rather than silently dropped. That is a
   * product call, not a side effect: `product_groups` carries no billing semantics
   * (db/schema/catalog.ts:18), so the engine is perfectly happy to keep billing an
   * add-on from another group, and quietly removing paid lines because a VIEW FILTER
   * changed would be the worst possible reading of an operator's intent. The plan is
   * called out separately because until it moves, nothing has actually changed.
   */
  const offGroupRows = group
    ? indexed.filter(
        ({ l }) =>
          !(l.kind === "existing" && l.removed) && l.price && !inGroup(productOfPrice(l.price)),
      )
    : [];
  const offGroupPlan = offGroupRows.find(({ l }) => slotOf(l) === "plan");
  const offGroupItems = offGroupRows.filter(({ l }) => slotOf(l) !== "plan");

  // CP-6 compatibility: add-on dropdowns list only add-ons applicable to the plan.
  const applicableAddonIds = new Set(
    rules.filter((r) => r.plan === planProduct?.id).map((r) => r.addon),
  );

  // ─── Catalog picker inputs (the modal itself is shared with the create form) ──
  /**
   * Candidate PRODUCTS, gated by plan applicability exactly as the row dropdowns are,
   * and by the product-group filter above — every picker on this page is scoped to
   * the selected group, which is the whole point of making that control real.
   */
  const catalogProducts = (kind: "plan" | "addon" | "charge"): Product[] =>
    products.filter(
      (p) =>
        p.active !== false &&
        p.kind === kind &&
        inGroup(p) &&
        (kind !== "addon" || applicableAddonIds.has(p.id)),
    );
  /**
   * The prices attachable to this subscription: its currency only — the backend
   * rejects a cross-currency change, so offering another one would defer the
   * rejection to submit. With one currency the picker drops that step.
   */
  const catalogPricesFor = (productId: string): Price[] =>
    prices.filter((p) => p.product === productId && p.active !== false && p.currency === currency);

  /**
   * Price-per-unit input adapter: the field edits MAJOR units; state stays minor.
   * The conversion goes through `lib/money.ts` rather than a literal 100 — a
   * subscription billed in JPY has no minor unit, so ÷100 showed ¥1000 as 10 and
   * ×100 posted 100000. The line's own price currency drives the exponent, falling
   * back to the subscription's.
   */
  const lineCurrency = (l?: Line): string =>
    (l ? priceById.get(l.price)?.currency : undefined) ?? currency;

  // ─── Changing a line's PRICE ─────────────────────────────────────────────────
  //
  // Which row is being re-priced, and by which of the three routes. Every one
  // of them opens the SAME searchable catalog modal the "+ Add …" links use, two rows
  // below in the same card — they used to swap the row's item cell for a flat,
  // unsorted Radix `Select` of every price instead (72 options on the plan row,
  // all three groups, `[0]` pro yearly / `[1]` business monthly / `[2]` pro monthly,
  // with the trigger clipping `platform-pro-v202607 · INR ₹279,180.00/` mid-value).
  // Re-pricing — the more dangerous job — had the worse picker.
  //
  // It also fixes the pricing lie: the Select labelled its options off
  // `price.amount_minor`, the raw CATALOG list price, which is legitimately 0 for
  // every imported differential add-on — so `⋮ → Edit` on the connections
  // add-on offered "INR ₹0.00/year" while the Add dialog beside it offered
  // "1 year · INR ₹7,520.00" for the same price id, and picking the ₹0.00 one billed
  // ₹7,520. The modal prices through `effectiveCatalogAmount`, the resolver the add
  // path already used, so one number comes out of one place.
  const [priceEdit, setPriceEdit] = React.useState<{
    index: number;
    mode: "plan" | "frequency" | "item";
  } | null>(null);

  const unitFieldValue = (l: Line): string =>
    l.unit_price_minor !== ""
      ? String(toMajor(Number(l.unit_price_minor), lineCurrency(l)))
      : priceById.get(l.price)
        ? String(toMajor(effectiveUnitMinor(l), lineCurrency(l)))
        : "";
  const onUnitFieldChange = (i: number, v: string) =>
    upd(i, {
      unit_price_minor: v.trim() === "" ? "" : String(toMinor(Number(v), lineCurrency(lines[i]))),
    });

  /**
   * How the catalog modal should open for the row being re-priced. Null when nothing
   * is being re-priced, which is also what keeps the modal unmounted — a fresh mount
   * is what makes its "follow the caller's open edge" effect fire on the right step.
   *
   * The three routes differ only in where they START and what they may offer:
   *  - `plan`      → `Search Plans`: step 1, every plan product in the selected
   *                  product group;
   *  - `frequency` → same product, other cadence. Step 1 would be a one-row search,
   *                  so it opens the Configure step with the line's own cadence
   *                  preselected — which is also what makes the dialog show where the
   *                  line stands before it moves;
   *  - `item`      → an add-on / charge `Edit`, opening on the line's own item.
   *                  Back still reaches the applicable catalog, so
   *                  swapping the line to a different add-on stays possible.
   */
  const priceEditConfig = (() => {
    if (!priceEdit) return null;
    const l = lines[priceEdit.index];
    if (!l) return null;
    const slot = slotOf(l);
    const product = productOfPrice(l.price);
    const startAt = product ? { product, priceId: l.price } : undefined;
    if (priceEdit.mode === "frequency") {
      if (!product) return null;
      return {
        index: priceEdit.index,
        label: "Change Frequency",
        products: [product],
        startAt,
        search: undefined,
        confirm: "Change frequency",
      };
    }
    if (slot === "plan") {
      return {
        index: priceEdit.index,
        label: "Change Plan",
        products: catalogProducts("plan"),
        startAt: undefined,
        search: "Search Plans…",
        confirm: "Change plan",
      };
    }
    const kind = slot === "charge" ? ("charge" as const) : ("addon" as const);
    const catalog = catalogProducts(kind);
    return {
      index: priceEdit.index,
      label: kind === "charge" ? "Edit charge" : "Edit add-on",
      // The item being edited can itself be off-group, or no longer applicable to the
      // plan — it still has to appear in its own picker.
      products:
        product && !catalog.some((p) => p.id === product.id) ? [product, ...catalog] : catalog,
      startAt,
      search: kind === "charge" ? "Search Charges…" : "Search Addons…",
      confirm: "Save",
    };
  })();

  const renderRow = (l: Line, i: number) => {
    const slot = slotOf(l);
    const prod = l.price ? productOfPrice(l.price) : undefined;
    const price = l.price ? priceById.get(l.price) : undefined;
    const isRemoved = l.kind === "existing" && l.removed;
    const lineTotal = effectiveUnitMinor(l) * (l.quantity || 1);
    const isPlan = slot === "plan";
    const qtyBased = isQuantityBased(price?.model);

    // "Change Frequency" is its own menu item, meaning "same product, another
    // cadence" — worth offering only when another cadence of this
    // product actually exists at this currency.
    const otherCadences = price
      ? catalogPricesFor(price.product).filter((p) => p.id !== price.id)
      : [];

    // A quantity-INVARIANT price (flat) has no meaningful unit×qty split, so we dash
    // both and make the AMOUNT the editable field; a per-unit one edits price + qty
    // and derives the amount. Same rule, applied to whichever the line actually is.
    const amountIsEditable = !qtyBased && !!l.price && !isRemoved;

    /**
     * The item's stored `product_name` snapshot — but ONLY while the line still carries
     * the price it was created with.
     *
     * Once the operator repoints a line at another product, the snapshot names the OLD
     * product while the amount, the interval and the subtitle all describe the new one.
     * Swapping the plan to `platform-lite-v202607` yearly left the row reading
     * `platform-pro-v202607 · yearly plan · 91180.00` — lite's price under pro's name —
     * while the confirm dialog fed by `diffRows` correctly said "Plan changed from
     * platform-pro-v202607 Monthly to platform-lite-v202607 Yearly". One screen, two
     * answers, and the wrong one was the one sitting next to the money.
     *
     * The snapshot still wins for an UNCHANGED line, where it is the honest record of
     * what the customer actually bought — the catalog product may have been renamed
     * since, and the row should not silently adopt the new name for an old purchase.
     */
    const displayName =
      (l.kind === "existing" && l.price === l.originalPrice ? l.productName : undefined) ||
      prod?.name ||
      price?.product ||
      (isPlan ? "Plan" : slot);

    return (
      <LineRow
        key={l.kind === "existing" ? l.itemId : `new-${slot}-${i}`}
        // A pending removal is a STATED outcome now, not a greyed-out row: it kept its
        // own snapshot values but rendered them through a disabled price Select, whose
        // label read `… · INR ₹0.00/month` off the catalog list price — so the row said
        // ₹0.00 while the rail beside it credited ₹7,520.00. `removing` keeps the
        // digits at full contrast and puts Restore in the row (see line-items.tsx).
        removing={isRemoved}
        restoreAction={
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => upd(i, { removed: false })}
            aria-label={`Restore ${displayName}`}
          >
            Restore
          </Button>
        }
        // Was a hardcoded green "IN" chip (it claimed India on a USD subscription) next
        // to the cadence. The chip is gone rather than corrected: every line shares one
        // currency — the engine refuses otherwise — so the table heading states it once.
        name={displayName}
        subtitle={lineSubtitle(price?.interval, slot)}
        badges={
          l.kind === "new" && l.required && !isRemoved ? (
            <Chip className="px-1.5 py-0 text-xs">Required</Chip>
          ) : null
        }
        // No `picker`: the item cell is static wrapped text on both screens now.
        // Price changes go through the catalog modal opened from the kebab.
        currency={price?.currency ?? currency}
        qtyBased={qtyBased}
        quantity={l.quantity}
        onQuantityChange={(q) => upd(i, { quantity: q })}
        unitValue={unitFieldValue(l)}
        onUnitChange={(v) => onUnitFieldChange(i, v)}
        unitDisabled={isRemoved || !l.price}
        amountMinor={price ? lineTotal : null}
        amountEditable={amountIsEditable}
        // Row actions. Every entry here does something.
        //
        // `Add Manual Discount` is on the PLAN kebab only (plan = Change Plan · Change
        // Frequency · Add Manual Discount; add-on = Edit · Remove, no discount item).
        // Ours is a SUBSCRIPTION-level discount, and the plan row IS the subscription's
        // plan, so the scope reads the same — the item opens the one inline panel in the
        // bar below rather than pretending to a per-line scope the engine lacks.
        actions={
          // Staged for removal: the only thing left to do to this row is put it back,
          // and that control is `restoreAction` above — beside the chip, because this
          // cell is a 2rem icon track and a text button here painted over the Amount.
          // A mandatory add-on the plan pulled in has no remove control at all (dropping
          // it would be rejected on submit); "Required" sits beside its name instead.
          isRemoved || (l.kind === "new" && l.required) ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Actions for ${displayName}`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={takeMdFocus}>
                {isPlan ? (
                  <>
                    <DropdownMenuItem onSelect={() => setPriceEdit({ index: i, mode: "plan" })}>
                      Change Plan
                    </DropdownMenuItem>
                    {/* Only offered when another cadence of this plan actually exists. */}
                    {otherCadences.length > 0 ? (
                      <DropdownMenuItem
                        onSelect={() => setPriceEdit({ index: i, mode: "frequency" })}
                      >
                        Change Frequency
                      </DropdownMenuItem>
                    ) : null}
                    {/* Opens the subscription-level panel in the bar below — the same
                        one `+ Add manual discount` opens, which
                        already posts to POST …/:sub/manual_discount. Always offered while
                        the subscription HAS no discount: see `openManualDiscount` for why
                        it is neither hidden nor disabled once the panel is already up.
                        Dropped entirely once one is applied, because the engine takes only
                        one and would refuse this. */}
                    {!keptDiscount ? (
                      <DropdownMenuItem onSelect={openManualDiscountFromMenu}>
                        Add Manual Discount
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => setPriceEdit({ index: i, mode: "item" })}>
                      Edit
                    </DropdownMenuItem>
                    {!l.required ? (
                      <DropdownMenuItem
                        variant="destructive"
                        // An existing item is STAGED for removal (the row then states it
                        // and offers Restore); a line that was only added on this screen
                        // never reached the engine, so it just goes.
                        onSelect={() =>
                          l.kind === "new" ? dropNewLine(i) : upd(i, { removed: true })
                        }
                      >
                        Remove
                      </DropdownMenuItem>
                    ) : null}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
    );
  };

  const footerFigure = reactivating ? (
    reactDeferred ? (
      <FooterFigure label="Due now" value={money(0, currency)} />
    ) : (
      <FooterFigure label={reactSummary.label} value={money(reactSummary.minor, currency)} />
    )
  ) : endTrialBlocked ? (
    <FooterFigure label="Due now" value="Blocked" />
  ) : endTrialNow ? (
    <FooterFigure
      label="Due now"
      value={endTrialDueMinor != null ? money(endTrialDueMinor, currency) : "Amount unknown"}
    />
  ) : estimate ? (
    <FooterFigure
      label="Due now"
      value={money(nothingDueNow ? 0 : amountDueMinor, estimate.currency)}
    />
  ) : (
    <FooterFigure label="Due now" value="—" />
  );

  const applyHint = inTrial ? "Applies now, billed at trial end" : "Applies today";

  return (
    <form ref={formRef} onSubmit={onSubmit}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <input
        type="hidden"
        name="payload"
        value={JSON.stringify(
          reactivating
            ? {
                ...reactPayload,
                // Sent only when it differs from the business rule, so the rule stays the default.
                ...(reactChargesNow && chargeFailure !== reactivationChargeFailure
                  ? { on_charge_failure: chargeFailure }
                  : {}),
              }
            : { ...payload, ...quoteFields, ...changeOverrides },
        )}
      />

      <ChangeSummaryDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={reactivating ? "Reactivate subscription?" : "Change subscription?"}
        fromStatus={reactivating ? "cancelled" : status}
        toStatus={toStatusResolved}
        diff={reactivating ? [] : diffRows}
        charges={
          reactivating
            ? reactCharges
            : scheduled
              ? []
              : firstTermCharges.length > 0
                ? firstTermCharges
                : changeCharges
        }
        currency={currency}
        headlineMinor={headlineMinor}
        headlineLabel={headlineLabel}
        headlineTone={
          (!reactivating && (billedAtTrialEnd || nothingDueNow)) ||
          (reactInTerm && !reactInTerm.collects_now)
            ? "info"
            : "warning"
        }
        chargesLabel={
          endTrialNow
            ? "Invoiced today. The trial ends now"
            : !reactivating && billedAtTrialEnd
              ? `Billed at trial end (${fmtDate(trialEndAtIso, tz)})`
              : deferChargesToUnbilled
                ? "Charges added to unbilled"
                : "Immediate charges"
        }
        // No tax row on the deferred branch: an unbilled charge is stored pre-tax and
        // the renewal that folds it in computes tax then, at that invoice's place of
        // supply. Quoting today's figure would make the footer disagree with the
        // headline AND with the document that eventually carries the line.
        // No tax row on the deferred branches. For a REACTIVATION the rows come from the
        // engine's `tax_lines[]` — named components, so an Indian invoice reads CGST +
        // SGST/UTGST as the document will print them and not one row called "Tax".
        // Undefined while the estimate is in flight: fewer rows, never invented ones.
        taxMinor={
          reactivating
            ? reactSummary.taxMinor
            : deferChargesToUnbilled
              ? undefined
              : firstTermCharges.length > 0
                ? firstTerm?.tax_minor
                : estimate?.tax_minor
        }
        taxLines={
          reactivating
            ? reactSummary.taxLines
            : deferChargesToUnbilled
              ? undefined
              : firstTermCharges.length > 0
                ? firstTerm?.tax_lines
                : estimate?.tax_lines
        }
        invoiceTotalMinor={showCreditNote ? invoiceTotalMinor : undefined}
        creditNoteTotalMinor={showCreditNote ? creditNoteMinor : undefined}
        creditAppliedToThisInvoiceMinor={showCreditNote ? creditAppliedHereMinor : undefined}
        creditDestinations={showCreditNote ? creditNarrative.destinations : undefined}
        creditedPeriodStart={showCreditNote ? creditNarrative.periodStart : undefined}
        creditedPeriodEnd={showCreditNote ? creditNarrative.periodEnd : undefined}
        fmtWhen={(iso) => fmtDateTime(iso, tz)}
        renewal={
          // Only where a renewal is a real, dated thing this change leads to. A trial
          // change bills at trial end (already stated in its own callout), a reactivation
          // has no estimate, and a scheduled apply has not decided its term yet.
          nextRenewal && !reactivating && !billedAtTrialEnd && !scheduled
            ? {
                charges: renewalCharges,
                subtotalMinor: nextRenewal.subtotal_minor,
                discountMinor: nextRenewal.discount_minor,
                taxMinor: nextRenewal.tax_minor,
                taxLines: nextRenewal.tax_lines,
                totalMinor: nextRenewal.total_minor,
                creditsAppliedMinor: nextRenewal.credits_applied_minor,
                amountDueMinor: nextRenewal.amount_due_minor,
                dateLabel: fmtDate(nextRenewal.date, tz),
              }
            : null
        }
        creditsMinor={summaryCreditsMinor}
        // ACCOUNT CREDIT, its own row and never silently netted: on a reactivation this is
        // the customer's own refundable/excess balance the invoice spends (₹9,661.13 on the
        // subscription #56 was measured on). `credit` rows render `success` — money coming
        // back — while charges stay neutral, which is the design system's rule for a
        // proration screen and the reason it is not flattened onto one token.
        balanceCreditsMinor={reactivating ? reactBalanceCreditsMinor : summaryBalanceCreditsMinor}
        promotionalDiscountMinor={
          reactivating ? reactPromotionalDiscountMinor : summaryPromotionalDiscountMinor
        }
        couponDiscountMinor={reactivating ? reactCouponDiscountMinor : couponDiscountMinor}
        totalMinor={summaryTotalMinor}
        totalLabel={summaryTotalLabel}
        loading={reactivating ? reactEstimating : !scheduled && estimating}
        emptyNote={
          trialDateOnlyChange
            ? `Moving the trial end charges nothing today. We raise the first invoice on ${fmtDate(trialEndAt, tz)} instead of ${fmtDate(trialEnd, tz)}.`
            : endTrialBlocked
              ? `${customerName} has no payment method on file, and this subscription auto-collects. We cannot end the trial, because the conversion would cancel the subscription for no card instead of activating it. Add a payment method. Or disable auto-collection, so that we send the first invoice instead of charging it.`
              : endTrialNow
                ? // Never "no immediate charge" here: ending the trial activates the
                  // subscription and raises + collects the first term's invoice today.
                  endTrialDueMinor != null
                  ? `Ending the trial activates the subscription and invoices the first term today: ${money(endTrialDueMinor, currency)} ${currency}.`
                  : "Ending the trial activates the subscription and invoices the first term today. We could not preview the amount."
                : scheduled
                  ? "This change is scheduled. We raise no charge now."
                  : estimateError
                    ? // Do not claim "no immediate charge" when the preview FAILED — we do not
                      // know what apply would book. Adds and removes are priced now, so a genuinely
                      // empty estimate does mean nothing moves; an errored one means nothing is known.
                      "We could not preview this change, so the amount is unknown. Fix the error above before you apply the change."
                    : "No immediate charge for this change."
        }
        note={
          deferChargesToUnbilled ? (
            <>
              We add these lines to the subscription as unbilled charges. We bill them on the next
              renewal invoice, where we apply tax and any account credits. We charge nothing to the
              payment method today.
              {removes.length > 0 ? (
                <>
                  {" "}
                  We credit removed items immediately, as a credit note. The deferral applies to
                  charges only.
                </>
              ) : null}
            </>
          ) : undefined
        }
        proceedDisabled={submitDisabled}
        pending={submitting}
        proceedLabel={reactivating ? "Reactivate" : "Save changes"}
        onProceed={() => formRef.current?.requestSubmit()}
      />
      <SubFormFrame
        crumbs={[
          { label: businessName, href: `/businesses/${biz}` },
          { label: "Subscriptions", href: `/businesses/${biz}/subscriptions` },
          { label: sub, href: `/businesses/${biz}/subscriptions/${sub}` },
          { label: reactivating ? "Reactivate" : "Change" },
        ]}
        // The payer sits at the top of this page. A link, not a picker — the customer of
        // an existing subscription cannot be changed here (no route accepts it).
        lead={
          customerId ? (
            <a
              href={`/businesses/${biz}/customers/${customerId}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/60 px-3 py-1 text-sm font-medium wrap-anywhere transition-colors hover:bg-accent"
            >
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
              {customerName || customerId}
            </a>
          ) : null
        }
        title={reactivating ? "Reactivate subscription" : "Change subscription"}
        description={
          <>
            <span className="font-mono">{sub}</span> · {currency}
            {reactivating
              ? reactInTerm
                ? ". Cancelled. The current term continues."
                : ". Cancelled. A new term starts today."
              : inTrial
                ? ". In trial. Changes apply now, and we first bill them at trial end."
                : ". Changes prorate against the current term."}
          </>
        }
        status={
          applyError ? (
            <ErrorState title={applyErrorTitle} description={applyError} />
          ) : error ? (
            <ErrorState description={error} />
          ) : null
        }
        cancelHref={`/businesses/${biz}/subscriptions/${sub}`}
        footerNote={`${reactivating ? "Reactivate" : "Save"} asks you to confirm before we charge anything`}
        footerFigure={footerFigure}
        primary={
          <Button type="button" disabled={submitDisabled} onClick={() => setConfirmOpen(true)}>
            {reactivating ? "Reactivate" : <ShortLabel full="Save changes" short="Save" />}
          </Button>
        }
        aside={
          <>
            <RecordCard title="What happens on apply">
              {reactivating ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {reactInTerm ? (
                    <>
                      <li>
                        The subscription is reactivated in its current term, which ends{" "}
                        {fmtDate(reactInTerm.current_period_end, tz)}.
                      </li>
                      <li>
                        We raise no new invoice.{" "}
                        {reactInTerm.invoice.outstanding_minor > 0 ? (
                          <>
                            Invoice {reactInTerm.invoice.number ?? reactInTerm.invoice.id} has{" "}
                            <b>{money(reactInTerm.invoice.outstanding_minor, currency)}</b> open.
                            {reactInTerm.collects_now
                              ? " We collect it before we reactivate. If the payment fails, the subscription stays cancelled."
                              : " It stays open."}
                          </>
                        ) : (
                          <>
                            Invoice {reactInTerm.invoice.number ?? reactInTerm.invoice.id} already
                            pays for this term.
                          </>
                        )}
                      </li>
                    </>
                  ) : (
                    <li>
                      The subscription is reactivated. A new term starts today with the line items
                      above.
                    </li>
                  )}
                  {reactInTerm ? null : reactTrialEnd ? (
                    <li>
                      Reactivated into a trial that ends {fmtDateTime(reactTrialEnd, tz)}. No charge
                      until then.
                    </li>
                  ) : chargesHandling === "add_to_unbilled_charges" ? (
                    <li>
                      The new term&rsquo;s charge (<b>{money(reactivationTermMinor, currency)}</b>)
                      is added to unbilled charges. We invoice it at the next renewal.
                    </li>
                  ) : (
                    <li>
                      We raise an invoice of <b>{money(reactivationTermMinor, currency)}</b>{" "}
                      immediately for the new term.
                    </li>
                  )}
                  {reactChargesNow && !reactInTerm ? (
                    <li>
                      {chargeFailure === "refuse"
                        ? "If the payment fails, we do not reactivate. The subscription stays cancelled, and we raise no invoice."
                        : "If the payment fails, the subscription becomes active. The invoice stays open, and dunning collects it."}
                    </li>
                  ) : null}
                  <li>
                    Billing cycles:{" "}
                    {billingCyclesMode === "limited" && billingCyclesN
                      ? `limited to ${billingCyclesN} cycle(s)`
                      : "forever"}
                    .
                  </li>
                  {!hasPlanLine ? (
                    <li className="text-destructive">Add a plan line before reactivating.</li>
                  ) : null}
                </ul>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {/* Nothing has been billed on a trial yet, so nothing can be prorated
                  or credited — every composition change lands on the trial-end
                  invoice instead (backend: proration.billsAtTrialEnd). */}
                  {inTrial && (removes.length > 0 || adds.length > 0 || changes.length > 0) ? (
                    <li>
                      This subscription is in trial. We raise no invoice, credit note or charge now.
                      We bill the full new composition when the trial ends
                      {trialEnd ? (
                        <>
                          {" "}
                          on <b>{fmtDate(trialEnd, tz)}</b>
                        </>
                      ) : null}
                      .
                    </li>
                  ) : null}
                  {/* ONE bullet for a DEFERRED edit, covering all three lists.
                  The removes/adds bullets below state immediate money ("unused time is
                  credited back", "prorated for the remainder of the term") which is
                  false on a schedule — nothing moves today. They were unreachable with
                  an add or a remove on the form while a schedule could only carry
                  `changes[]`; now that POST …/schedule carries the whole edit
                  (2026-08-31) they are reachable, so the scheduled case takes over the
                  whole trio instead of sitting alongside two contradictions. */}
                  {applyIsScheduled ? (
                    hasLineWork ? (
                      <li>
                        {scheduledEditParts.join(", ")}
                        {effectiveApplyAt ? (
                          <>
                            . Scheduled for <b>{fmtDateTime(effectiveApplyAt, tz)}</b>
                            {applyWhen === "end_of_term" ? ` (${termEndNoun})` : ""}. We invoice it
                            when it applies. We charge or credit nothing today.
                          </>
                        ) : (
                          // Deferred, but the date is still blank — saying "changed with
                          // immediate proration" here contradicted the rail and the disabled
                          // submit button.
                          ". We schedule it when you select a date. We charge nothing today."
                        )}
                      </li>
                    ) : null
                  ) : (
                    <>
                      {removes.length > 0 ? (
                        <li>
                          {removes.length} item(s) removed
                          {inTrial ? "." : ". We credit back the unused time."}
                        </li>
                      ) : null}
                      {adds.length > 0 ? (
                        <li>
                          {adds.length} new item(s) added
                          {inTrial ? "." : ", prorated for the remainder of the term."}
                        </li>
                      ) : null}
                      {changes.length > 0 ? (
                        <li>
                          {changes.length} existing item(s) changed
                          {inTrial
                            ? "."
                            : // Proration off: the bullet below states what happens instead. This
                              // one claimed "with immediate proration" directly above it, so the
                              // list contradicted itself in two adjacent lines.
                              prorateApplies && !prorate
                              ? "."
                              : deferChargesToUnbilled
                                ? ". We add the prorated charge to unbilled charges and bill it on the next renewal, not now."
                                : " with immediate proration (see the estimate)."}
                        </li>
                      ) : null}
                    </>
                  )}
                  {/* KEPT when the estimate gained its own `prorate` (2026-08-24) and the two
                  notices apologising for the rail ignoring the flag were deleted. This one
                  is not an apology: it never mentioned the estimate, it states an APPLY
                  outcome, and this list states one per choice the operator made — the
                  removal, coupon, discount and cycles bullets around it all do the same
                  for figures the rail already shows. */}
                  {prorateApplies && !prorate && changes.length > 0 ? (
                    <li>
                      Proration is <b>off</b> for the {changes.length} changed line(s). We book no
                      prorated credit or charge for them
                      {effectiveResetTerm
                        ? ", but the term still resets and we charge the full new term."
                        : ", so we raise no invoice and no credit note for them."}
                    </li>
                  ) : null}
                  {changeOverrides.on_charge_failure ? (
                    <li>
                      If the payment fails:{" "}
                      <b>{FAILED_CHANGE_LABELS[changeOverrides.on_charge_failure]}</b>. This change
                      only.
                    </li>
                  ) : null}
                  {changeOverrides.coupons ? (
                    <li>
                      Coupons: <b>{PLAN_CHANGE_COUPON_LABELS[changeOverrides.coupons]}</b>. This
                      change only.
                    </li>
                  ) : null}
                  {changeOverrides.downgrade_credit ? (
                    <li>
                      Credit: <b>{DOWNGRADE_CREDIT_LABELS[changeOverrides.downgrade_credit]}</b>.
                      This change only.
                    </li>
                  ) : null}
                  {changeOverrides.plan_credits ? (
                    <li>
                      Plan credits: <b>{CREDIT_UPGRADE_LABELS[changeOverrides.plan_credits]}</b>.
                      This change only.
                    </li>
                  ) : null}
                  {changeOverrides.allowances ? (
                    <li>
                      Usage allowances:{" "}
                      <b>{ALLOWANCE_UPGRADE_LABELS[changeOverrides.allowances]}</b>. This change
                      only.
                    </li>
                  ) : null}
                  {cyclesChanged ? (
                    <li>
                      Billing cycles set to{" "}
                      <b>
                        {cyclesValue == null
                          ? "renew forever"
                          : cyclesValue === 0
                            ? "end at the current term"
                            : `${cyclesValue} more renewal(s) after the current term`}
                      </b>
                      .
                    </li>
                  ) : null}
                  {/* Billing cycles rides the same PATCH but has its own bullet above, so
                  this one names only the other three — it used to list all of them
                  whatever had actually changed. */}
                  {Object.keys(settings).some((k) => k !== "remaining_billing_cycles") ? (
                    <li>Billing info (auto-collection / PO number / invoice notes) updated.</li>
                  ) : null}
                  {couponCode ? <li>Coupon code &ldquo;{couponCode}&rdquo; applied.</li> : null}
                  {manualDiscount ? (
                    <li>
                      Manual discount (
                      {manualDiscount.type === "amount"
                        ? money(manualDiscount.value, currency)
                        : `${manualDiscount.value}%`}
                      , {manualDiscount.duration === "one_time" ? "one time" : "forever"}) applied.
                    </li>
                  ) : null}
                  {endTrialBlocked ? (
                    <li>
                      Nothing. We cannot end the trial while {customerName} has no payment method
                      and this subscription auto-collects, because the conversion would cancel it
                      for no card.
                    </li>
                  ) : endTrialNow ? (
                    <li>
                      The trial ends today. The subscription activates, and we invoice the first
                      term now.
                    </li>
                  ) : trialEndChanged ? (
                    <li>Trial end moved to {fmtDateTime(trialEndAt, tz)}.</li>
                  ) : null}
                  {!dirty ? <li>No changes yet.</li> : null}
                </ul>
              )}
            </RecordCard>
            {reactivating ? (
              <RecordCard title={reactInTerm ? "Current term" : "New term"}>
                <div className="flex flex-col gap-3">
                  <div>
                    <StatusChip status={toStatusResolved} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {reactInTerm ? (
                      <>
                        The current term continues and renews on{" "}
                        <b>{fmtDate(reactInTerm.current_period_end, tz)}</b>
                      </>
                    ) : (
                      <>
                        A new term starts <b>{fmtDate(new Date().toISOString(), tz)}</b>
                      </>
                    )}
                    {planPrice && !reactInTerm ? (
                      <>
                        {" "}
                        and renews on{" "}
                        <b>
                          {fmtDate(
                            (reactTrialEnd
                              ? new Date(reactTrialEnd)
                              : addTerm(
                                  new Date(),
                                  planPrice.interval,
                                  planPrice.interval_count ?? 1,
                                )
                            ).toISOString(),
                            tz,
                          )}
                        </b>
                      </>
                    ) : null}
                    .
                  </p>
                  <div className="rounded-lg border p-3">
                    {reactLadder.map((r, i) => (
                      <div
                        key={r.label}
                        className={cn(
                          "flex items-center justify-between gap-3",
                          r.kind === "total"
                            ? "mt-1.5 border-t pt-1.5 text-sm font-semibold"
                            : "text-xs",
                          // Credits are `success` and charges neutral — on a money screen the
                          // direction IS the information, and it is never flattened onto one
                          // token. Same rule as the confirm dialog's footer.
                          r.kind === "credit"
                            ? "text-success"
                            : r.kind === "muted"
                              ? "text-muted-foreground"
                              : undefined,
                          i === 0 && r.kind === "total" ? "mt-0 border-t-0 pt-0" : undefined,
                        )}
                      >
                        <span>{r.label}</span>
                        <span className="tabular-nums">
                          {r.kind === "credit" ? "−" : ""}
                          {money(r.amountMinor, currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {!hasPlanLine ? (
                    <p className="text-sm text-destructive">Add a plan line to reactivate.</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {reactEstimateError
                        ? // Say what is missing rather than let a subtotal read as the charge.
                          `Full new-term price of every line above, before tax and account credit. We could not preview the taxed total (${reactEstimateError}).`
                        : reactInTerm
                          ? "We raise no new invoice, because the current term continues. Every figure above comes from the engine."
                          : reactEstimate
                            ? // Keyed off the ESTIMATE, not off the branch: the trial and
                              // unbilled branches also state engine figures, and claiming
                              // "full new-term price" of a taxed total was the old wording's
                              // problem in miniature.
                              "No proration, because the subscription was cancelled. Every figure above comes from the engine, for the invoice that this raises."
                            : reactEstimating
                              ? "Full new-term price of every line above, before tax and account credit. Previewing…"
                              : "Full new-term price of every line above. No proration, because the subscription was cancelled."}
                    </p>
                  )}
                </div>
              </RecordCard>
            ) : (
              <>
                <RecordCard title="New term">
                  <p className="text-xs text-muted-foreground">
                    {endTrialBlocked ? (
                      <>
                        <b>No payment method on file.</b> You cannot end the trial now while this
                        subscription auto-collects. The conversion would cancel it for no card,
                        instead of raising an invoice that nothing can pay.
                      </>
                    ) : endTrialNow ? (
                      <>
                        The trial ends <b>today</b>. The subscription activates, and we raise the
                        first invoice now instead of at {fmtDate(trialEnd, tz)}.
                      </>
                    ) : billedAtTrialEnd ? (
                      <>
                        Trial ends <b>{fmtDate(trialEndAtIso, tz)}</b>. We raise the first invoice
                        then. We do not prorate changes during a trial.
                      </>
                    ) : estimate?.term_reset ? (
                      <>
                        Subscription renews on <b>{fmtDate(estimate.new_period_end, tz)}</b>. The
                        term resets today.
                      </>
                    ) : status === "in_trial" ? (
                      // `current_period_end` is deliberately NULL while in trial (see serialize.ts)
                      // because the TRIAL END is the next billing boundary — so read that instead.
                      // Rendering currentPeriodEnd here printed "Subscription renews on —".
                      <>
                        Trial ends <b>{fmtDate(trialEnd, tz)}</b>. We raise the first invoice then.
                        We do not prorate changes during a trial.
                      </>
                    ) : (
                      // The status is the chip above now, not a word buried in this sentence.
                      //
                      // "Current term ends", NOT "Subscription renews on" — and the wording is the
                      // fix, not a preference. This panel prints TWO dates for what a reader takes
                      // to be one event, and they differ by a day because they come from opposite
                      // conventions: `current_period_end` is served through `inclusiveBoundary`
                      // (`subscriptions/serialize.ts`) so it names the term's LAST DAY, while the
                      // renewal line below prints `next_renewal.date`, the raw EXCLUSIVE instant the
                      // next invoice is raised at. Both are correct; "renews on 30-Sept" beside
                      // "next invoice will be raised on 01-Oct" simply asks the operator to
                      // reconcile them.
                      //
                      // Fixed by naming the two facts differently rather than by changing either
                      // date — a term that ends on the 30th and an invoice raised on the 1st are
                      // adjacent instants, not a contradiction. Changing the DATE instead would have
                      // meant either printing the exclusive instant here (contradicting the
                      // inclusive convention every other screen uses for a term end) or printing the
                      // inclusive day below (claiming the invoice is raised a day before it is).
                      //
                      // ⚠ The `term_reset` branch above still says "renews on" over
                      // `estimate.new_period_end`, which IS the raw exclusive instant — so it already
                      // agrees with the renewal line and is left alone. The estimate exposes no
                      // inclusive form, and inventing one here would be a second convention.
                      <>
                        Current term ends <b>{fmtDate(currentPeriodEnd, tz)}</b>.
                      </>
                    )}
                  </p>
                </RecordCard>
                <RecordCard
                  title={
                    endTrialNow
                      ? "First term estimate"
                      : billedAtTrialEnd
                        ? "Trial end estimate"
                        : "Proration estimate"
                  }
                >
                  <div className="flex flex-col gap-3">
                    {/* The rail leads with the status chip; it used to state the status in
          prose further down, which read flatter. The chip
          is the same primitive the create rail and the confirm dialog use, so the
          three now agree. */}
                    <div>
                      <StatusChip status={status} />
                    </div>
                    {estimating ? (
                      <p className="text-sm text-muted-foreground">Estimating…</p>
                    ) : null}
                    {estimateError ? (
                      <p className="text-sm text-destructive">{estimateError}</p>
                    ) : null}
                    {!estimate && !estimating && !estimateError ? (
                      <p className="text-sm text-muted-foreground">
                        Change, add or remove a line to preview the proration.
                      </p>
                    ) : null}
                    {estimate ? (
                      <>
                        {/* A deferred apply moves no money today, so the rail must not lead with
              "Chargeable immediately" — it sat directly above "nothing is charged
              today" and contradicted it. The estimate itself still prices the change
              as if applied now (there is no dry run at a future instant); the box
              under the rail says so. */}
                        <div
                          className={cn(
                            "space-y-2 rounded-lg border p-4",
                            nothingDueNow
                              ? "border-info/25 bg-info-soft"
                              : "border-warning/25 bg-warning-soft",
                          )}
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              className={cn(
                                "flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-background",
                                nothingDueNow ? "bg-info" : "bg-warning",
                              )}
                            >
                              {nothingDueNow ? "i" : "!"}
                            </span>
                            {/* In trial nothing is charged now (the backend raises no invoice
                  and no credit note) — the figure that matters is the trial-end
                  bill, so lead with "nothing due" and quote the date. */}
                            {scheduled ? (
                              <div>
                                <div className="text-xl font-bold text-foreground">
                                  Nothing due now
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  Applied{" "}
                                  {effectiveApplyAt
                                    ? fmtDateTime(effectiveApplyAt, tz)
                                    : applyWhen === "end_of_term"
                                      ? "at the next renewal"
                                      : "on the selected date"}
                                </div>
                              </div>
                            ) : endTrialBlocked ? (
                              <div>
                                <div className="text-xl font-bold text-foreground">Blocked</div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  no payment method on file. Add one, or disable auto-collection
                                </div>
                              </div>
                            ) : endTrialNow ? (
                              // The trial boundary moves to today, so the trial-end invoice is
                              // raised and collected NOW. Saying "nothing due now" here would be
                              // the same false money statement the deferred branch above fixed.
                              <div>
                                <div className="text-xl font-bold wrap-anywhere text-foreground tabular-nums">
                                  {endTrialDueMinor != null
                                    ? `${money(endTrialDueMinor, currency)} ${currency}`
                                    : "Amount unknown"}
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  {endTrialDueMinor != null
                                    ? "first term, invoiced today (trial ends now)"
                                    : "first term is invoiced today. We could not get the estimate"}
                                </div>
                              </div>
                            ) : billedAtTrialEnd ? (
                              <div>
                                <div className="text-xl font-bold text-foreground">
                                  Nothing due now
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  <span className="tabular-nums">
                                    {money(netMinor, estimate.currency)} {estimate.currency}
                                  </span>{" "}
                                  billed at trial end ({fmtDate(trialEndAtIso, tz)})
                                </div>
                              </div>
                            ) : deferChargesToUnbilled ? (
                              // Deferred: the figure is the PRE-TAX subtotal that lands in
                              // unbilled charges, not `amount_due` — tax and account credits
                              // are computed by the renewal invoice that folds it in.
                              <div>
                                <div className="text-xl font-bold wrap-anywhere text-foreground tabular-nums">
                                  {money(deferredBookedMinor, estimate.currency)}{" "}
                                  {estimate.currency}
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  Added to unbilled charges. We bill them at the next renewal
                                </div>
                              </div>
                            ) : netCreditNow && nextRenewal ? (
                              // ⚠ THIS BRANCH EXISTS BECAUSE THE RAIL HAD ITS OWN HEADLINE. The
                              // confirm dialog reads `headlineMinor`/`headlineLabel`, which already
                              // re-point at the renewal for a net credit — but the rail rendered
                              // `amountDueMinor` + a hardcoded "Chargeable immediately" instead, so
                              // one screen said "₹89,845.20 · Chargeable on renewal" while the panel
                              // beside it said "₹0.00 · Chargeable immediately" for the same change.
                              // Measured in a browser, 2026-08-30. Same rule and wording as the
                              // dialog now.
                              <div>
                                <div className="text-xl font-bold wrap-anywhere text-foreground tabular-nums">
                                  {money(nextRenewal.amount_due_minor, estimate.currency)}{" "}
                                  {estimate.currency}
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  Chargeable on renewal
                                </div>
                              </div>
                            ) : (
                              <div>
                                <div className="text-xl font-bold wrap-anywhere text-foreground tabular-nums">
                                  {money(amountDueMinor, estimate.currency)} {estimate.currency}
                                </div>
                                <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                                  {netCreditNow
                                    ? "Nothing due today. This change credits the customer"
                                    : "Chargeable immediately"}
                                </div>
                              </div>
                            )}
                          </div>
                          {/* The buyer's mandate cannot carry this charge, and the operator has
                to know BEFORE they commit — not from a failed payment afterwards.
                Measured 2026-08-18: a ₹5,000/mo customer upgraded to ₹28,215/mo,
                the change was accepted, MRR updated, and the proration invoice it
                raised was refused on the spot. Warning, not a block: the merchant
                may well be about to ask the customer to re-authorise, and refusing
                the upgrade outright would take away a legitimate order of
                operations. */}
                          {/* A debit is still live at the rail on an invoice this edit is about
                to credit. Crediting it does NOT cancel it, and on a card mandate
                nothing can — `voidIntent` needs an intent id and an authorized
                recurring charge is captured or left to lapse. So it may still
                settle for a debt the credit note has already cleared; the money is
                then booked, detached, auto-refunded and alerted, which is a detour
                the operator can spare the customer by asking them to release it
                first. A warning and never a block: waiting on a customer's bank is
                not a reason to refuse an operator a legitimate edit. */}
                          {estimate.debits_in_flight?.length ? (
                            <Alert
                              tone="warning"
                              className="mt-3"
                              title="A payment is not settled on an invoice that this will credit"
                            >
                              {estimate.debits_in_flight.map((d) => d.invoice).join(", ")}
                              {estimate.debits_in_flight.length === 1 ? " has" : " have"}
                              {estimate.debits_in_flight.some((d) => d.kind === "intent")
                                ? " a payment the customer started at the gateway, and it has not settled."
                                : " a debit the gateway has accepted but not settled."}{" "}
                              Crediting the invoice does not cancel the payment. The payment may
                              still be charged and then refunded automatically.
                              {/* FOUR different waits, because the remedy differs and naming the
                    wrong one sends the operator to a control that cannot act.
                    `kind` splits a debit WE dispatched from a checkout the BUYER
                    opened: the portal's release control keys on the invoice's
                    in-progress transaction, and an intent has none — measured
                    2026-09-03 on INV-7824, where a ₹22,184.00 checkout was live at
                    RazorPay with no payments and no transactions row at all. So
                    "they can release it from their portal" is true of a debit and
                    false of a checkout. */}
                              {estimate.debits_in_flight.some((d) => d.kind === "intent")
                                ? estimate.debits_in_flight.some((d) => d.awaiting_buyer)
                                  ? " The customer has the gateway's payment window open, so only the customer can complete or stop it. The release control in their portal cannot stop a checkout. If they close it first, no charge and refund occur."
                                  : " The gateway already holds their money for it, and the customer has no more steps to do. The billing clock releases the hold if the gateway allows it. If the gateway does not allow it (Razorpay), we book the capture and refund it automatically."
                                : estimate.debits_in_flight.some((d) => d.awaiting_buyer)
                                  ? " Their bank is waiting for the customer, so the customer can release the debit from their billing portal. If they do that first, no charge and refund occur."
                                  : " It should settle soon without action. If you apply this edit after it settles, no charge and refund occur."}
                            </Alert>
                          ) : null}
                          {estimate.mandate_shortfall ? (
                            <Alert
                              tone="warning"
                              className="mt-3"
                              title="This charge exceeds the customer's mandate"
                            >
                              Their {estimate.mandate_shortfall.rail ?? "mandate"} authorises a
                              maximum of{" "}
                              <b className="tabular-nums">
                                {money(
                                  estimate.mandate_shortfall.ceiling_minor,
                                  estimate.mandate_shortfall.currency,
                                )}
                              </b>{" "}
                              per debit. We will refuse{" "}
                              <b className="tabular-nums">
                                {money(
                                  estimate.mandate_shortfall.amount_minor,
                                  estimate.mandate_shortfall.currency,
                                )}
                              </b>{" "}
                              before it reaches the gateway. The change still applies, and the
                              invoice waits. The customer must authorise again, which would register{" "}
                              <b className="tabular-nums">
                                {money(
                                  estimate.mandate_shortfall.reauthorized_ceiling_minor,
                                  estimate.mandate_shortfall.currency,
                                )}
                              </b>
                              . The invoice then collects automatically.
                              {estimate.mandate_shortfall.needs_authentication_even_if_raised
                                ? " This amount is also over ₹15,000. On a card or UPI mandate, the customer must" +
                                  " approve each debit with their bank. Only a netbanking e-mandate collects" +
                                  " this amount without customer action."
                                : ""}
                            </Alert>
                          ) : null}
                          {/* Credits are only "applied" by an immediate apply — under a deferred
                one nothing has moved yet, so these rows would be claims about money
                that has not changed hands. The proration credit for unused time is
                an exception: it is queued alongside the charge and is already
                netted into the figure above. */}
                          {/* ⚠ These two bullets carried the SAME sentence — "refundable credits
                applied" — for two different things, and the first quoted the wrong
                number for it: `creditsMinor` is the credit LINES, pre-tax, which is
                neither what the note is worth nor what the invoice absorbs. On the
                reported change it read "₹45,120.00 refundable credits applied" where
                the true figure was ₹887.36. Now: what the note actually covers of this
                invoice, and separately the customer's own balance being spent. */}
                          {/* ⚠ WAS `Math.min(creditNoteMinor, invoiceTotalMinor)` — a THIRD local
                derivation of "what this invoice absorbed", and wrong in the same
                direction as the ladder it sat under: the cap ignores every slice that
                went somewhere else, so on the reported change it claimed ₹71,654.32
                applied where the routing applied ₹66,566.31. The engine reports the
                figure; nothing here may reconstruct it. */}
                          {showCreditNote && creditAppliedHereMinor > 0 ? (
                            <div className="flex items-center gap-2 pt-1 text-xs font-medium text-foreground">
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-xs font-bold text-background">
                                ✓
                              </span>
                              <span className="tabular-nums">
                                {money(creditAppliedHereMinor, estimate.currency)}{" "}
                                {estimate.currency} credit for unused time applied to this invoice
                              </span>
                            </div>
                          ) : null}
                          {!scheduled && !deferChargesToUnbilled && balanceCreditsMinor > 0 ? (
                            <div className="flex items-center gap-2 pt-1 text-xs font-medium text-foreground">
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-xs font-bold text-background">
                                ✓
                              </span>
                              <span className="tabular-nums">
                                {money(balanceCreditsMinor, estimate.currency)} {estimate.currency}{" "}
                                account credits applied
                              </span>
                            </div>
                          ) : null}
                          {/* The engine's own figure, not `-netMinor` inferred from a sign: they
                agree today (what the invoice cannot absorb IS the negative total),
                but one is derived where the other is measured. */}
                          {showCreditNote && refundableAddedMinor > 0 ? (
                            <div className="flex items-center gap-2 pt-1 text-xs font-medium text-foreground">
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-xs font-bold text-background">
                                ✓
                              </span>
                              <span className="tabular-nums">
                                {money(refundableAddedMinor, estimate.currency)} {estimate.currency}{" "}
                                refundable credits go back to the customer&apos;s account
                              </span>
                            </div>
                          ) : null}
                          <div className="pt-2">
                            <button
                              type="button"
                              onClick={() => setBreakdownOpen(true)}
                              className="text-xs font-semibold text-primary hover:underline"
                            >
                              See breakdown
                            </button>
                          </div>
                        </div>
                        {/* The two branches this replaced quoted the same hand-summed figure and
              differed only in which date they read — `new_period_end` on a term
              reset, `currentPeriodEnd` otherwise. The engine already resolves that
              fork (`next_renewal.date`), so there is one sentence now and no way
              for the amount and the date to come from different calculations. */}
                        {billedAtTrialEnd ? null : nextRenewal ? ( // a second "next invoice" sentence would just restate it. // The callout above already states the trial-end amount and date;
                          <p className="text-xs text-muted-foreground">
                            We raise the next invoice of{" "}
                            <b className="tabular-nums">
                              {money(nextRenewal.amount_due_minor, estimate.currency)}
                            </b>
                            {/* Deferring puts the proration ON that invoice, so quoting the
                  recurring figure alone would understate it. */}
                            {deferChargesToUnbilled ? (
                              <>
                                {" "}
                                plus the{" "}
                                <b className="tabular-nums">
                                  {money(deferredBookedMinor, estimate.currency)}
                                </b>{" "}
                                queued above
                              </>
                            ) : null}{" "}
                            on <b>{fmtDate(nextRenewal.date, tz)}</b>
                            {nextRenewal.credits_applied_minor > 0 ? (
                              <>
                                {": "}
                                <b className="tabular-nums">
                                  {money(nextRenewal.total_minor, estimate.currency)}
                                </b>{" "}
                                less the{" "}
                                <b className="tabular-nums">
                                  {money(nextRenewal.credits_applied_minor, estimate.currency)}
                                </b>{" "}
                                credit that this change gives back
                              </>
                            ) : null}
                            .
                          </p>
                        ) : null}
                        <Dialog open={breakdownOpen} onOpenChange={setBreakdownOpen}>
                          <DialogContent
                            size="sm"
                            className="flex max-h-[85vh] flex-col overflow-hidden"
                          >
                            <DialogHeader>
                              <DialogTitle>
                                {scheduled
                                  ? applyWhen === "end_of_term"
                                    ? "Breakdown at the end of the term"
                                    : "Breakdown if applied today"
                                  : billedAtTrialEnd
                                    ? endTrialNow
                                      ? "Breakdown of the first-term invoice"
                                      : "Breakdown of the trial-end invoice"
                                    : deferChargesToUnbilled
                                      ? "Breakdown of the unbilled charges"
                                      : "Breakdown of Immediate Charges"}
                              </DialogTitle>
                              <DialogDescription>
                                {scheduled
                                  ? applyWhen === "end_of_term"
                                    ? "We charge nothing when you apply this change. These figures show the change as it applies at the end of the term."
                                    : "We charge nothing when you apply this change. The engine prices a deferred change on its effective date, so these figures show the value as of today."
                                  : billedAtTrialEnd
                                    ? endTrialNow
                                      ? "The trial ends today. This is what the first invoice contains when you confirm."
                                      : "We charge nothing when you apply this change. This is what the first invoice contains when the trial ends."
                                    : deferChargesToUnbilled
                                      ? "We add these lines to the subscription and bill them on the next renewal invoice. The tax below is the tax on them today. The renewal calculates the tax again at its own rate and place of supply."
                                      : "Summary of the charges that we apply when you confirm"}
                              </DialogDescription>
                            </DialogHeader>
                            <div className="-mx-6 min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
                              <div
                                className={cn(
                                  "space-y-1 rounded-lg border p-3 text-sm",
                                  nothingDueNow
                                    ? "border-info/25 bg-info-soft"
                                    : "border-warning/25 bg-warning-soft",
                                )}
                              >
                                <div className="font-semibold tabular-nums">
                                  {money(
                                    billedAtTrialEnd
                                      ? netMinor
                                      : deferChargesToUnbilled
                                        ? deferredBookedMinor
                                        : amountDueMinor,
                                    estimate.currency,
                                  )}{" "}
                                  {estimate.currency}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {scheduled
                                    ? "Value as of today. Nothing due now"
                                    : billedAtTrialEnd
                                      ? `Billed at trial end (${fmtDate(trialEndAtIso, tz)}). Nothing due now`
                                      : deferChargesToUnbilled
                                        ? "Added to unbilled charges. Nothing due now"
                                        : "Chargeable immediately"}
                                </div>
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="border-b text-left text-xs text-muted-foreground">
                                      <th className="py-1.5 font-medium">Items</th>
                                      <th className="py-1.5 text-right font-medium">
                                        Amount ({estimate.currency})
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {estimate.lines
                                      .filter((ln) => ln.amount_minor > 0)
                                      .map((ln, i) => (
                                        <tr key={i} className="border-b">
                                          <td className="py-1.5 pr-2 wrap-break-word">
                                            {lineFormatter.describe(ln.description)}
                                          </td>
                                          <td className="py-1.5 text-right tabular-nums">
                                            {money(ln.amount_minor, estimate.currency)}
                                          </td>
                                        </tr>
                                      ))}
                                    {/* ── ORDER MATTERS, and it did not add up before ───────────────
                      This ran items → "Subtotal" → Tax → "Total" → Credits, where
                      `subtotal_minor` is the NET (items − credits) and "Total" was
                      `chargesMinor + tax` — the GROSS items plus a tax computed on the
                      NET. So the subtotal read smaller than the single line above it,
                      and the total was an amount charged to nobody. Measured on a
                      quantity change: item ₹8,732.90, "Subtotal" ₹1,455.48, "Total"
                      ₹8,994.88, headline ₹1,717.46.
                      The confirm dialog one step later was already coherent, so this is
                      its shape: items → credit → net subtotal → tax → amount due.
                      chargesMinor − creditsMinor === subtotal_minor, and
                      subtotal_minor + tax_minor === total_minor, both by construction. */}
                                    {/* SUBTOTAL IS THE CHARGES ALONE — the invoice's own subtotal.
                      It used to be `estimate.subtotal_minor`, which is net of the
                      credit's PRE-tax amount, sitting directly above a tax row
                      computed on the charges GROSS of it. Two conventions, one
                      column, and the rows below could not reconcile. */}
                                    {estimate.tax_minor > 0 ? (
                                      <tr className="border-b text-muted-foreground">
                                        <td className="py-1.5">Subtotal</td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {money(chargesMinor, estimate.currency)}
                                        </td>
                                      </tr>
                                    ) : null}
                                    {/* BEFORE the tax row, and unconditional on tax: promotional credit
                      is a pre-tax discount, so the tax beneath it is charged on the
                      subtotal LESS this. Without the row the table jumped from a
                      subtotal to an amount due that was smaller by an unexplained
                      amount — the same defect on the preview that 30fcbd6 fixed on
                      the invoice. */}
                                    {couponDiscountMinor > 0 ? (
                                      <tr className="border-b text-success">
                                        <td className="py-1.5">Discounts</td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          −{money(couponDiscountMinor, estimate.currency)}
                                        </td>
                                      </tr>
                                    ) : null}
                                    {promotionalDiscountMinor > 0 ? (
                                      <tr className="border-b">
                                        <td className="py-1.5">Promotional credits</td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          −{money(promotionalDiscountMinor, estimate.currency)}
                                        </td>
                                      </tr>
                                    ) : null}
                                    {/* THE ROWS THE INVOICE WILL PRINT — `CGST (9.00%)` + `SGST (9.00%)`,
                      or `IGST (18.00%)`. A single "Tax" row is not what an Indian
                      invoice says, and the buyer meets the split later with nothing
                      connecting it to this quote. Falls back to one row only when the
                      engine names no components. */}
                                    {estimate.tax_minor > 0 ? (
                                      estimate.tax_lines?.length ? (
                                        estimate.tax_lines.map((t) => (
                                          <tr
                                            key={t.label}
                                            className="border-b text-muted-foreground"
                                          >
                                            <td className="py-1.5">{t.label}</td>
                                            <td className="py-1.5 text-right tabular-nums">
                                              {money(t.amount_minor, estimate.currency)}
                                            </td>
                                          </tr>
                                        ))
                                      ) : (
                                        <tr className="border-b text-muted-foreground">
                                          <td className="py-1.5">Tax</td>
                                          <td className="py-1.5 text-right tabular-nums">
                                            {money(estimate.tax_minor, estimate.currency)}
                                          </td>
                                        </tr>
                                      )
                                    ) : null}
                                    {/* THIS INVOICE ONLY. `Invoice total` then
                      `credits_applied`, and nothing else: the gross note and its other
                      destinations are sentences under the table, because a column about
                      one document cannot also narrate a second one. The pair this
                      replaced (gross credit, then `+ Cleared unpaid invoices` added
                      back) reconciled correctly and still made an operator read a `+`
                      beneath a credit. */}
                                    {showCreditNote ? (
                                      <>
                                        <tr className="border-b text-muted-foreground">
                                          <td className="py-1.5">Invoice total</td>
                                          <td className="py-1.5 text-right tabular-nums">
                                            {money(invoiceTotalMinor, estimate.currency)}
                                          </td>
                                        </tr>
                                        {creditAppliedHereMinor > 0 ? (
                                          <tr className="border-b text-success">
                                            <td className="py-1.5">Credit applied</td>
                                            <td className="py-1.5 text-right tabular-nums">
                                              −{money(creditAppliedHereMinor, estimate.currency)}
                                            </td>
                                          </tr>
                                        ) : null}
                                      </>
                                    ) : null}
                                    {!scheduled &&
                                    !deferChargesToUnbilled &&
                                    balanceCreditsMinor > 0 ? (
                                      <tr className="border-b text-success">
                                        <td className="py-1.5">Credits applied from balance</td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          −{money(balanceCreditsMinor, estimate.currency)}
                                        </td>
                                      </tr>
                                    ) : null}
                                    {/* The same figure the headline shows, so the table can never
                      disagree with the number the operator is about to confirm. */}
                                    <tr className="border-b font-medium">
                                      <td className="py-1.5">
                                        {billedAtTrialEnd
                                          ? "Billed at trial end"
                                          : deferChargesToUnbilled
                                            ? "Added to unbilled charges"
                                            : "Amount due"}
                                      </td>
                                      <td className="py-1.5 text-right tabular-nums">
                                        {money(
                                          billedAtTrialEnd
                                            ? netMinor
                                            : deferChargesToUnbilled
                                              ? deferredBookedMinor
                                              : amountDueMinor,
                                          estimate.currency,
                                        )}
                                      </td>
                                    </tr>
                                    {/* `Refundable credit added back` was the last row here, after
                      "Amount due", "because it moves the other way". That was the tell:
                      a row a column has to place AFTER its own total is not a movement
                      on that document at all. It is a destination of the credit note, so
                      it is now one of the Credits sentences below. */}
                                  </tbody>
                                </table>
                              </div>
                              {/* ── CREDITS ────────────────────────────────────────────────────
                  This section already existed — a `Credits` heading with prose under
                  the charges table — which is why the ladder above could shed its rows into
                  it rather than needing a new section invented.

                  It now states EVERY leg from `creditLegSentences`, the same wording the
                  buyer's checkout and the confirm dialog render, so the three surfaces
                  cannot explain one split three ways. The old copy named a single
                  destination ("applied to the immediate invoice") and a single type
                  ("refundable"), both of which are wrong on an unpaid term: that credit
                  is an ADJUSTMENT and its first slice goes to the term's own invoice.

                  The deferred branch keeps its own sentence — nothing is applied to
                  anything yet there, so the leg breakdown would describe placements that
                  have not happened. It is stated from `creditsMinor` (pre-tax), which is
                  what is actually queued. */}
                              {!scheduled && deferChargesToUnbilled && creditsMinor > 0 ? (
                                <div className="space-y-1">
                                  <h3 className="text-sm font-semibold">Credits</h3>
                                  <p className="text-sm text-muted-foreground">
                                    {`We add prorated credits of ${money(creditsMinor, estimate.currency)} for the unused period with the charges. They reduce the charges on the renewal invoice.`}
                                  </p>
                                </div>
                              ) : !scheduled && creditSentences.length > 0 ? (
                                <div className="space-y-1">
                                  <h3 className="text-sm font-semibold">Credits</h3>
                                  <div className="space-y-1 text-sm text-muted-foreground">
                                    {creditSentences.map((s, i) => (
                                      <p key={i}>{s}</p>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </DialogContent>
                        </Dialog>
                      </>
                    ) : null}
                    {/* This box used to warn that added and removed lines were "applied as separate
          operations, so each one is invoiced or credited on its own document rather than
          folded into a single invoice" — true until 2026-08-24, when `/change` learned to
          carry `adds` and `removes` and apply all three in one transaction. The whole
          edit is now one invoice (plus credit notes for the unused time), so the warning
          became a false statement about our own behaviour and is gone rather than
          reworded: there is nothing left to caveat.
          ⚠ It used to claim "one credit note" — measured across three real changes, the
          engine issues TWO: an `adjustment` note against the term's unpaid invoice (if
          any) and a `refundable` note for the remainder. Match the CREDITS section above,
          which already states this correctly. */}
                    {(adds.length > 0 || removes.length > 0) && dirty ? (
                      <SummaryBox>
                        This estimate includes added and removed lines. We apply the whole edit as
                        one operation. It raises one invoice, plus credit notes for the unused time.
                        The credit is an adjustment against any unpaid invoice, and refundable
                        credit for the remainder. We charge nothing for a line that the same edit
                        removes.
                      </SummaryBox>
                    ) : null}
                    {applyIsScheduled ? (
                      <SummaryBox>
                        {applyWhen === "end_of_term"
                          ? "The estimate shows the change as it applies at the term end. Nothing is left to prorate then, so the change goes on the renewal invoice at full price."
                          : "The estimate shows immediate proration. A scheduled change prorates on its effective date instead."}
                      </SummaryBox>
                    ) : null}
                  </div>
                </RecordCard>
              </>
            )}
          </>
        }
      >
        <RecordCard title="Items" meta={currency} flush>
          <div className="flex flex-col gap-3 px-5 py-4 empty:hidden">
            {/* Product group — a FILTER, not a required field. Full
              reasoning at the `group` state above; the short version is that the
              engine has no group constraint, so a disabled field with a red
              asterisk was a false statement about a page whose own plan picker
              offered all three groups. Same control the create form renders,
              defaulted here to the subscription's CURRENT group. */}
            {productGroups.length > 0 ? (
              <div className="flex max-w-sm flex-col gap-1.5">
                <span className="text-sm font-medium">Filter plans by product group</span>
                <SelectField
                  value={group}
                  onValueChange={setGroup}
                  ariaLabel="Filter plans by product group"
                  options={[
                    { value: "", label: "All product groups" },
                    ...productGroups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
                <span className="text-xs text-muted-foreground">
                  Limits every picker below. Change it to move this subscription to the plan of
                  another group. The subscription&rsquo;s group follows its plan.
                </span>
              </div>
            ) : null}
            {offGroupRows.length > 0 ? (
              <Alert tone="warning">
                {offGroupPlan ? (
                  <>
                    This subscription&rsquo;s plan is still{" "}
                    <b>{productOfPrice(offGroupPlan.l.price)?.name ?? offGroupPlan.l.price}</b> from{" "}
                    <b>{groupName(productOfPrice(offGroupPlan.l.price)?.product_group)}</b>. Use the
                    plan row&rsquo;s <b>Change Plan</b> to select one from {groupName(group)}.
                    Nothing changes until you do.
                  </>
                ) : null}
                {offGroupItems.length > 0 ? (
                  <>
                    {offGroupPlan ? " " : null}
                    {offGroupItems.length} line
                    {offGroupItems.length === 1 ? "" : "s"} (
                    {offGroupItems
                      .map(({ l }) => productOfPrice(l.price)?.name ?? l.price)
                      .join(", ")}
                    ) belong to another product group and <b>stay in place</b>. Product groups have
                    no effect on billing, so these lines continue to bill as they are. Remove them
                    here if they must not stay after the move.
                  </>
                ) : null}
              </Alert>
            ) : null}
          </div>
          <LineItemsCard
            bare
            footer={
              <>
                <LineActionsBar>
                  <CatalogAddModal
                    label="Add recurring addon"
                    effectiveAmountMinor={effectiveCatalogAmount}
                    products={catalogProducts("addon")}
                    pricesFor={catalogPricesFor}
                    productById={productById}
                    searchPlaceholder="Search addons…"
                    onAdd={(priceId) =>
                      setLines((ls) => [
                        ...ls,
                        {
                          kind: "new",
                          price: priceId,
                          quantity: 1,
                          unit_price_minor: "",
                          slot: "addon",
                          required: false,
                        },
                      ])
                    }
                  />
                  <LineActionSeparator />
                  <CatalogAddModal
                    label="Add charge"
                    effectiveAmountMinor={effectiveCatalogAmount}
                    products={catalogProducts("charge")}
                    pricesFor={catalogPricesFor}
                    productById={productById}
                    searchPlaceholder="Search charges…"
                    onAdd={(priceId) =>
                      setLines((ls) => [
                        ...ls,
                        {
                          kind: "new",
                          price: priceId,
                          quantity: 1,
                          unit_price_minor: "",
                          slot: "charge",
                          required: false,
                        },
                      ])
                    }
                  />
                </LineActionsBar>
                {/* Coupons + manual discount, the second bar. Both coupon entry
                    points fill the same `coupon_code`; hidden once one is applied,
                    since a second would silently replace the first. */}
                <LineActionsBar>
                  {/* Nothing to add when one is already applied — the engine allows a
                      single discount per subscription and refuses the second outright,
                      so these would be controls that cannot do what they say. The row
                      in the Coupons group below states what is applied instead. */}
                  {!keptDiscount && !couponCode && !showCouponCode ? (
                    <>
                      <CouponPickerModal
                        coupons={coupons}
                        currency={currency}
                        label="Add coupon"
                        onSelect={setCouponCode}
                      />
                      <LineActionSeparator label="OR" />
                      <LineActionLink onClick={() => setShowCouponCode(true)}>
                        Add coupon code
                      </LineActionLink>
                      <LineActionSeparator />
                    </>
                  ) : null}
                  {showCouponCode ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Input
                        autoFocus
                        value={couponDraft}
                        onChange={(e) => setCouponDraft(e.target.value)}
                        placeholder="Coupon code"
                        maxLength={100}
                        className="w-56 max-w-full"
                        aria-label="Coupon code"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!couponDraft.trim()}
                        onClick={() => {
                          setCouponCode(couponDraft.trim());
                          setCouponDraft("");
                          setShowCouponCode(false);
                        }}
                      >
                        Apply
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowCouponCode(false);
                          setCouponDraft("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                  {/* Same single-discount rule as the coupon links above. */}
                  {!mdOpen && !keptDiscount ? (
                    <LineActionLink onClick={openManualDiscount}>
                      Add manual discount
                    </LineActionLink>
                  ) : mdOpen ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                      <SelectField
                        value={mdType}
                        onValueChange={(v) => setMdType(v as "percent" | "amount")}
                        ariaLabel="Manual discount type"
                        className="w-44"
                        options={[
                          { value: "percent", label: "Percentage (%)" },
                          { value: "amount", label: "Fixed amount" },
                        ]}
                      />
                      <Input
                        type="number"
                        min={mdType === "percent" ? 1 : 0}
                        max={mdType === "percent" ? 100 : undefined}
                        step={mdType === "percent" ? 1 : 0.01}
                        ref={mdValueRef}
                        value={mdValue}
                        onChange={(e) => setMdValue(e.target.value)}
                        placeholder="Value"
                        className="w-28 tabular-nums"
                        aria-label="Manual discount value"
                        aria-invalid={mdValueInvalid ? true : undefined}
                      />
                      <SelectField
                        value={mdDuration}
                        onValueChange={(v) => setMdDuration(v as "one_time" | "forever")}
                        ariaLabel="Manual discount duration"
                        className="w-36"
                        options={[
                          { value: "one_time", label: "One time" },
                          { value: "forever", label: "Forever" },
                        ]}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setMdOpen(false);
                          setMdValue("");
                        }}
                      >
                        Remove
                      </Button>
                      {mdValueInvalid ? (
                        <p className="w-full text-xs font-medium text-destructive">
                          {mdType === "percent"
                            ? "Percent must be between 1 and 100."
                            : "Enter an amount greater than zero."}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </LineActionsBar>
              </>
            }
          >
            {/* Plan section */}
            <LineGroupLabel>Plan</LineGroupLabel>
            {planRows.map(({ l, i }) => renderRow(l, i))}

            {/* Add-ons section */}
            {addonRows.length > 0 ? (
              <>
                <LineGroupLabel>Add-ons</LineGroupLabel>
                {addonRows.map(({ l, i }) => renderRow(l, i))}
              </>
            ) : null}

            {/* Charges section */}
            {chargeRows.length > 0 ? (
              <>
                <LineGroupLabel>One-time products</LineGroupLabel>
                {chargeRows.map(({ l, i }) => renderRow(l, i))}
              </>
            ) : null}

            {/* Coupons section — the applied coupon is listed among the line items
                with its duration. The discount figure is the coupon's own and
                is NOT netted into the Amount column: the estimate endpoint does not
                take a coupon, so the rail on the right prices the change
                undiscounted, and showing a discounted line here would make the two
                disagree with nothing on screen reconciling them. */}
            {appliedDiscount || couponCode ? (
              <>
                <LineGroupLabel>Coupons</LineGroupLabel>
              </>
            ) : null}
            {appliedDiscount ? (
              /*
                ALREADY ON THE SUBSCRIPTION. Remove marks it for removal in THIS edit
                (`remove_discount`), so the rail re-prices without it before confirm and
                nothing on this screen is lost; Restore takes the mark back.
              */
              <LineRow
                removing={removeApplied}
                restoreAction={
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => setRemoveApplied(false)}
                  >
                    Restore
                  </Button>
                }
                actions={
                  removeApplied ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoveApplied(true)}
                      className="size-8 p-0 text-muted-foreground hover:text-foreground"
                      aria-label="Remove discount"
                    >
                      ✕
                    </Button>
                  )
                }
                name={
                  appliedDiscount.source === "manual"
                    ? "Manual discount"
                    : (appliedDiscount.coupon ?? appliedDiscount.code)
                }
                subtitle={
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* No code line: `name` above already IS the code. */}
                    <span>Already applied</span>
                    {appliedDiscount.remaining_periods != null ? (
                      <span>
                        ·{" "}
                        {appliedDiscount.remaining_periods === 1
                          ? "1 invoice remaining"
                          : `${appliedDiscount.remaining_periods} invoices remaining`}
                      </span>
                    ) : null}
                    {/* NO "not included in the estimate" caveat here, unlike the
                        typed-coupon row below. `estimateChange` calls
                        `peekDiscounts(tx, sub.id, …)`, which loads the subscription's
                        ACTIVE discounts — so the rail already prices this one in.
                        Repeating the other row's caption would have been a false
                        statement about the figure beside it. */}
                  </span>
                }
                currency={currency}
                qtyBased={false}
                amountText={
                  appliedDiscount.source === "manual" && appliedDiscount.manual
                    ? appliedDiscount.manual.kind === "fixed_amount"
                      ? money(
                          appliedDiscount.manual.amount_off_minor ?? 0,
                          appliedDiscount.manual.currency ?? currency,
                        )
                      : `${(appliedDiscount.manual.percent_off_bps ?? 0) / 100}%`
                    : "—"
                }
              />
            ) : null}
            {couponCode ? (
              <>
                <LineRow
                  name={appliedCoupon?.name || couponCode}
                  subtitle={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono wrap-anywhere">{couponCode}</span>
                      <span>
                        ·{" "}
                        {appliedCoupon
                          ? couponDurationLabel(appliedCoupon)
                          : "We check it when you apply the change"}
                      </span>
                    </span>
                  }
                  currency={currency}
                  qtyBased={false}
                  amountText={appliedCoupon ? couponDiscountLabel(appliedCoupon, currency) : "—"}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCouponCode("");
                        setShowCouponCode(false);
                      }}
                      className="size-8 p-0 text-muted-foreground hover:text-foreground"
                      aria-label="Remove coupon"
                    >
                      ✕
                    </Button>
                  }
                />
              </>
            ) : null}
          </LineItemsCard>
          {/* The one price-change surface for every row, mounted only while a row is
              being re-priced. Same component, same search box and same differential
              pricing as the "+ Add …" links in the card above — see `priceEdit`. */}
          {priceEditConfig ? (
            <CatalogAddModal
              open
              onOpenChange={(next) => {
                if (!next) setPriceEdit(null);
              }}
              label={priceEditConfig.label}
              confirmLabel={priceEditConfig.confirm}
              products={priceEditConfig.products}
              pricesFor={catalogPricesFor}
              productById={productById}
              searchPlaceholder={priceEditConfig.search}
              startAt={priceEditConfig.startAt}
              effectiveAmountMinor={effectiveCatalogAmount}
              onAdd={(priceId) => {
                const np = priceById.get(priceId);
                // A flat price has no unit×qty split, so a move onto one resets the
                // quantity — the same rule the row dropdown applied.
                upd(priceEditConfig.index, {
                  price: priceId,
                  ...(np && !isQuantityBased(np.model) ? { quantity: 1 } : {}),
                });
              }}
            />
          ) : null}
        </RecordCard>

        <RecordCard title={reactivating ? "Reactivation" : "Apply changes"}>
          {reactivating ? (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground">
                {reactInTerm
                  ? `Reactivation continues the current billing term, which ends ${fmtDate(reactInTerm.current_period_end, tz)}.`
                  : "Reactivation restarts this subscription with a new billing term that starts today."}
              </p>

              {/* Term: offered only when the engine says this reactivation can continue it. */}
              {reactivating && !reactTrialEnd && reactEstimate?.in_term_available ? (
                <div className="space-y-2">
                  <span className="text-sm font-medium">Term</span>
                  <RadioField
                    name="reactivation_term"
                    ariaLabel="Term"
                    value={reactTerm}
                    onValueChange={(v) => setReactTerm(v as typeof reactTerm)}
                    options={[
                      { value: "continue", label: "Continue the current term" },
                      { value: "new", label: "Start a new term today" },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">
                    {reactTerm === "continue"
                      ? "Dunning cancelled this subscription inside its term. The term continues and we raise no new invoice."
                      : "A new term starts today, and we bill it. The open invoice of the cancelled term stays open."}
                  </p>
                </div>
              ) : null}

              {/* Billing cycles cap */}
              <div className="space-y-2">
                <span className="text-sm font-medium">Billing Cycles</span>
                <div className="flex flex-wrap items-center gap-4">
                  <RadioField
                    name="billing_cycles_mode"
                    ariaLabel="Billing cycles"
                    value={billingCyclesMode}
                    onValueChange={(v) => setBillingCyclesMode(v as "forever" | "limited")}
                    className="flex flex-row items-center gap-6"
                    options={[
                      { value: "forever", label: "Forever" },
                      { value: "limited", label: "Limited to" },
                    ]}
                  />
                  {/* The count sits beside the "Limited to" option rather than
                      inside its label — typing in it selects that option. */}
                  <span className="flex items-center gap-2 text-sm">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={billingCyclesN}
                      onChange={(e) => {
                        setBillingCyclesN(e.target.value);
                        setBillingCyclesMode("limited");
                      }}
                      placeholder="N"
                      className="w-24"
                      aria-label="Number of billing cycles"
                    />
                    cycles
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  The number of terms to bill before the subscription cancels automatically.
                </p>
              </div>

              {/* Trial end (optional) */}
              <Field
                name="reactivation_trial_end"
                label="Trial End At (optional)"
                help={
                  <>
                    Reactivate into a trial that ends at this time. No charge until then.
                    {reactEstimate?.in_term_available ? " A trial always starts a new term." : null}
                    {reactTrialEnd && new Date(reactTrialEnd).getTime() < Date.now() ? (
                      <span className="ml-1 text-warning">You have selected a past date.</span>
                    ) : null}
                  </>
                }
              >
                <DateTimeField
                  defaultValue={reactTrialEnd}
                  onUtcChange={setReactTrialEnd}
                  className="w-64"
                />
              </Field>

              {/* Invoicing options. Omitted in term: there is no new charge to place. */}
              {reactInTerm ? null : (
                <div className="space-y-2">
                  <span className="text-sm font-medium">When should the invoice be generated?</span>
                  <RadioField
                    name="charges_handling"
                    ariaLabel="When should the invoice be generated?"
                    value={chargesHandling}
                    onValueChange={(v) => setChargesHandling(v as typeof chargesHandling)}
                    options={[
                      {
                        value: "invoice_immediately",
                        label: "Immediately",
                        disabled: Boolean(reactTrialEnd),
                      },
                      {
                        value: "add_to_unbilled_charges",
                        label: "Add to unbilled charges",
                        disabled: Boolean(reactTrialEnd),
                      },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">
                    {reactTrialEnd
                      ? "We generate no invoice during the trial. The first charge occurs when the trial ends."
                      : "Unbilled charges go on the next renewal invoice. We do not bill them now."}
                  </p>
                </div>
              )}

              {/* Only when a charge is taken on apply: otherwise there is no payment to fail. */}
              {reactChargesNow ? (
                <div className="space-y-2">
                  <span className="text-sm font-medium">If the payment fails</span>
                  <RadioField
                    name="on_charge_failure"
                    ariaLabel="If the payment fails"
                    value={chargeFailure}
                    onValueChange={(v) => setChargeFailure(v as typeof chargeFailure)}
                    options={[
                      {
                        value: "refuse",
                        label: "Do not reactivate",
                        hint: reactInTerm
                          ? "We collect the open invoice first. The subscription stays cancelled if the payment fails."
                          : "We charge first. The subscription stays cancelled, and we raise no invoice.",
                      },
                      {
                        value: "dun",
                        label: "Reactivate, and dunning collects the invoice",
                        hint: "The subscription becomes active. Dunning tries again, as after a failed renewal.",
                      },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">
                    Applies to this reactivation only. The business setting is &ldquo;
                    {reactivationChargeFailure === "refuse"
                      ? "Do not reactivate"
                      : "Reactivate, and dunning collects the invoice"}
                    &rdquo;.
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <FieldBlock label="When do you want to apply the changes?">
                <ChoiceCardsField
                  name="apply_when"
                  value={applyWhen}
                  onValueChange={(v) => setApplyWhen(v as typeof applyWhen)}
                  ariaLabel="When do you want to apply the changes?"
                  columns={
                    (allowNow ? 1 : 0) + (allowLater ? (canApplyAtTermEnd ? 2 : 1) : 0) === 3
                      ? 3
                      : 2
                  }
                  options={[
                    // The business timing rule can take options away (Settings › Billing
                    // rules › Update subscription); /change and /schedule refuse them too.
                    ...(allowNow
                      ? [{ value: "immediately", label: "Immediately", hint: applyHint }]
                      : []),
                    // "On next renewal (end of term)", and "On activation" while the
                    // subscription is in a trial — one option, because both are the same
                    // schedule at the same boundary (see `termEndAnchor`). Omitted only
                    // when there is no such boundary to resolve at all.
                    ...(canApplyAtTermEnd && allowLater
                      ? [
                          {
                            value: "end_of_term",
                            label: inTrial
                              ? "On activation (end of trial)"
                              : "On next renewal (end of term)",
                            hint: fmtDateTime(termEndAnchor!, tz),
                          },
                        ]
                      : []),
                    ...(allowLater
                      ? [
                          {
                            value: "specific_date",
                            label: "On a specific date",
                            hint: "Select a date",
                          },
                        ]
                      : []),
                  ]}
                />
              </FieldBlock>
              {changeBlocked ? <Alert tone="warning">{changeBlocked.message}</Alert> : null}
              {applyWhen === "immediately" ? (
                <div className="flex flex-col gap-3">
                  {/* Editable since `changeSubBody.prorate` landed (2026-08-22). */}
                  <CheckboxField
                    checked={inTrial ? false : prorate}
                    disabled={inTrial}
                    onCheckedChange={setProrate}
                    label="Apply prorated credits and charges"
                    hint={
                      inTrial
                        ? "Not applicable during a trial. We did not bill anything yet, so nothing is available to prorate."
                        : prorate
                          ? "Credits the unused time on the old price and charges the new one for the rest of the term."
                          : "Stops the prorated credit and charge for the CHANGED lines. The composition changes, and we book no money. On a frequency change, the term still resets and we charge the full new term. Only the unused-time credit is dropped. Added and removed lines do not change, so a removal still credits."
                    }
                  />
                  <CheckboxField
                    checked={resetTerm || frequencyChanged}
                    disabled={frequencyChanged}
                    onCheckedChange={setResetTerm}
                    label="Reset billing term: start a new term today"
                    hint={
                      inTrial
                        ? "During a trial, the term is the trial period, and we never move its start. A frequency change only changes the cadence of the first paid term."
                        : frequencyChanged
                          ? "The billing frequency changes, so the term resets automatically. We charge the full new term and credit the unused time."
                          : "Credits all unused time and charges the full new-term price from today."
                    }
                  />
                </div>
              ) : null}
              {applyWhen === "end_of_term" && canApplyAtTermEnd ? (
                <p className="text-xs text-muted-foreground">
                  {inTrial ? (
                    <>
                      Applied on <b>{fmtDateTime(termEndAnchor!, tz)}</b>, when the trial ends. We
                      then raise the first invoice for the changed lines, not the current ones. We
                      charge nothing today.
                    </>
                  ) : (
                    <>
                      Applied on <b>{fmtDateTime(termEndAnchor!, tz)}</b>, immediately before we
                      raise the renewal invoice. We charge or credit nothing today.
                    </>
                  )}
                </p>
              ) : null}
              {applyWhen === "specific_date" ? (
                <DateTimeField
                  defaultValue={applyAt}
                  onUtcChange={setApplyAt}
                  className="w-64 max-w-full"
                  aria-label="Apply at"
                />
              ) : null}
              {/* Both deferred modes take the same POST …/schedule path, which carries the
                  whole composition edit and applies it in one transaction when it lands.
                  A schedule needs at least one LINE: the billing-info, coupon and
                  trial-end sections post immediately either way. */}
              {scheduleMissingChanges ? (
                <p className="text-sm text-muted-foreground">
                  Change, add or remove a line above to schedule it.
                </p>
              ) : null}
            </div>
          )}
        </RecordCard>

        {/*
          INVOICING OPTIONS — a real section: `invoice_immediately` on POST …/:sub/change.
          Built around the ONE control identified as its substance (invoice now vs add to
          unbilled charges). Any further control here needs a backend field FIRST. The
          prorate toggle lives on Apply changes above.
        */}
        {reactivating ? null : (
          <RecordCard title="Invoicing">
            {invoicingOptionApplies ? (
              <div className="flex flex-col gap-2">
                <FieldBlock label="How should this change be invoiced?">
                  <ChoiceCardsField
                    ariaLabel="How should this change be invoiced?"
                    value={invoiceImmediately ? "true" : "false"}
                    onValueChange={(v) => setInvoiceImmediately(v === "true")}
                    options={[
                      {
                        value: "true",
                        label: "Invoice immediately",
                        hint: "Raises the proration invoice now and tries to collect from the payment method.",
                      },
                      {
                        value: "false",
                        label: "Add to unbilled charges",
                        hint: "We add the charges to this subscription and bill them on the next renewal invoice, with tax and account credits. No money moves now.",
                      },
                    ]}
                  />
                </FieldBlock>
                {removes.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Removals always credit unused time as a credit note. This choice applies to
                    charges only.
                  </p>
                ) : null}
              </div>
            ) : (
              // No radio where the choice cannot reach the engine. Each branch states the
              // outcome that WILL happen instead.
              <p className="text-sm text-muted-foreground">
                {status === "in_trial"
                  ? "We invoice nothing during a trial. We bill this change in full when the trial ends, so no charge needs an invoicing choice."
                  : "We invoice a change for a future date when it applies. A scheduled change has no invoicing option of its own. To select an option, apply the change immediately."}
              </p>
            )}
          </RecordCard>
        )}

        {/* Business rules this change may override. Each shows only where it has an effect. */}
        {showChargeFailure || showCoupons || showCredit || showPlanCredits || showAllowances ? (
          <RecordCard title="Change options">
            <div className="flex flex-col gap-4">
              {showChargeFailure ? (
                <FieldBlock
                  label="If the payment fails"
                  help={ruleHelp(FAILED_CHANGE_LABELS[changeRules.on_charge_failure])}
                >
                  <SelectField
                    ariaLabel="If the payment fails"
                    value={chargeFailureChoice}
                    onValueChange={(v) => setChargeFailureChoice(v as typeof chargeFailureChoice)}
                    className="w-full sm:w-80"
                    options={labelOptions(FAILED_CHANGE_LABELS)}
                  />
                </FieldBlock>
              ) : null}
              {showCoupons ? (
                <FieldBlock
                  label="Coupons on the new plan"
                  help={ruleHelp(PLAN_CHANGE_COUPON_LABELS[changeRules.coupons])}
                >
                  <SelectField
                    ariaLabel="Coupons on the new plan"
                    value={couponsChoice}
                    onValueChange={(v) => setCouponsChoice(v as typeof couponsChoice)}
                    className="w-full sm:w-80"
                    options={labelOptions(PLAN_CHANGE_COUPON_LABELS)}
                  />
                </FieldBlock>
              ) : null}
              {showCredit ? (
                <FieldBlock
                  label="Credit from this change"
                  help={ruleHelp(DOWNGRADE_CREDIT_LABELS[changeRules.downgrade_credit])}
                >
                  <SelectField
                    ariaLabel="Credit from this change"
                    value={creditChoice}
                    onValueChange={(v) => setCreditChoice(v as typeof creditChoice)}
                    className="w-full sm:w-80"
                    options={(["credit_balance", "refund"] as const).map((v) => ({
                      value: v,
                      label: DOWNGRADE_CREDIT_LABELS[v],
                    }))}
                  />
                </FieldBlock>
              ) : null}
              {showPlanCredits ? (
                <FieldBlock
                  label="Plan credits"
                  help={ruleHelp(
                    downgrading
                      ? CREDIT_DOWNGRADE_LABELS[changeRules.plan_credits.downgrade]
                      : CREDIT_UPGRADE_LABELS[changeRules.plan_credits.upgrade],
                  )}
                >
                  <SelectField
                    ariaLabel="Plan credits"
                    value={planCreditsChoice}
                    onValueChange={(v) => setPlanCreditsChoice(v as typeof planCreditsChoice)}
                    className="w-full sm:w-80"
                    options={labelOptions(
                      downgrading ? CREDIT_DOWNGRADE_LABELS : CREDIT_UPGRADE_LABELS,
                    )}
                  />
                </FieldBlock>
              ) : null}
              {showAllowances ? (
                <FieldBlock
                  label="Usage allowances"
                  help={ruleHelp(ALLOWANCE_UPGRADE_LABELS[changeRules.allowances])}
                >
                  <SelectField
                    ariaLabel="Usage allowances"
                    value={allowancesChoice}
                    onValueChange={(v) => setAllowancesChoice(v as typeof allowancesChoice)}
                    className="w-full sm:w-80"
                    options={labelOptions(ALLOWANCE_UPGRADE_LABELS)}
                  />
                </FieldBlock>
              ) : null}
            </div>
          </RecordCard>
        ) : null}

        <FormCard title="Billing">
          {/* Fixed once the subscription exists; the header and crumbs carry it too. */}
          <LockedField
            label="Subscription ID"
            value={sub}
            mono
            reason="Fixed once the subscription is created."
          />
          {/*
            Same control, same wording, same resolved-inherit hint as create's. The inherit
            option states the RESOLVED value: the customer's stored `auto_collection`, which
            is what the engine falls back to when the subscription's own column is null.
          */}
          <Field
            name="auto_collection"
            label="Auto-collection"
            help={
              <>
                Auto-collection tries to charge the customer&apos;s payment method automatically
                each time we create an invoice.
                {autoCollectionState === "" && customerAutoCollection ? (
                  <>
                    {" "}
                    {customerAutoCollection === "on"
                      ? `${customerName} uses auto-collection, so we charge invoices on this subscription to their payment method automatically.`
                      : `${customerName} uses manual collection, so we send invoices on this subscription instead of charging them.`}
                  </>
                ) : null}
              </>
            }
          >
            <SelectField
              ariaLabel="Auto-collection"
              value={autoCollectionState}
              onValueChange={setAutoCollectionState}
              options={[
                {
                  value: "",
                  label: customerAutoCollection
                    ? `Use customer's setting (currently ${customerAutoCollection === "on" ? "On" : "Off"})`
                    : "Use customer's setting",
                },
                { value: "on", label: "On: charge the card automatically" },
                { value: "off", label: "Off: send the invoice" },
              ]}
            />
          </Field>
          <Field name="po_number" label="PO number" help="Enter the Purchase Order Number.">
            <Input
              value={poNumberState}
              onChange={(e) => setPoNumberState(e.target.value)}
              maxLength={100}
            />
          </Field>
          <Field name="invoice_notes" label="Invoice notes">
            <Input
              value={invoiceNotesState}
              onChange={(e) => setInvoiceNotesState(e.target.value)}
              maxLength={2000}
            />
          </Field>
          {/* Billing cycles. Semantics and copy are BillingCyclesInline's, deliberately:
              "2" alone is ambiguous about whether the current term counts, and getting that
              wrong ends a paying subscription a term early. Omitted while reactivating —
              that flow has its own cap control, posting to a different route. */}
          {reactivating ? null : (
            <Wide>
              <FieldBlock
                label="Billing cycles"
                help={
                  <>
                    Renewals remaining <b>after the current term</b>, not a total. The billing clock
                    decreases this counter at each renewal. At 0, the subscription is non-renewing
                    and cancels at term end. Forever removes the limit.{" "}
                    {remainingBillingCycles == null
                      ? "Currently renews forever."
                      : remainingBillingCycles === 0
                        ? `Currently the last cycle${currentPeriodEnd ? `, ending ${fmtDate(currentPeriodEnd, tz)}` : ""}.`
                        : `Currently ${remainingBillingCycles} more renewal${remainingBillingCycles === 1 ? "" : "s"}.`}
                  </>
                }
              >
                <ChoiceCardsField
                  value={cyclesMode}
                  onValueChange={(v) => setCyclesMode(v as "forever" | "count")}
                  ariaLabel="Billing cycles"
                  options={[
                    { value: "forever", label: "Forever", hint: "Renews until cancelled" },
                    {
                      value: "count",
                      label: "A set number of renewals",
                      hint: "Renewals remaining after the current term",
                    },
                  ]}
                />
                {cyclesMode === "count" ? (
                  <span className="flex items-center gap-2 text-sm">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={cyclesN}
                      onChange={(e) => setCyclesN(e.target.value)}
                      className="w-24 tabular-nums"
                      aria-label="Renewals remaining after the current term"
                    />
                    after the current term
                  </span>
                ) : null}
              </FieldBlock>
            </Wide>
          )}
          {status === "in_trial" ? (
            <Wide>
              <div className="flex flex-col gap-4">
                <Field
                  name="trial_end_at"
                  label="Trial End At"
                  help="Moves the trial end. The first charge occurs then."
                >
                  <DateTimeField
                    defaultValue={trialEndAt}
                    onUtcChange={setTrialEndAt}
                    disabled={endTrialNow}
                  />
                </Field>
                <CheckboxField
                  checked={endTrialNow}
                  onCheckedChange={setEndTrialNow}
                  label="End the trial now"
                  hint="Activates the subscription today and invoices the first term immediately. We ignore the date above."
                />
                {endTrialBlocked ? (
                  <Alert tone="warning">
                    {customerName} has no payment method on file, and this subscription
                    auto-collects. We cannot end the trial, because the conversion would cancel the
                    subscription for no card. Add a payment method. Or set auto-collection to{" "}
                    <b>Off</b> above, so that we send the first invoice instead.
                  </Alert>
                ) : null}
              </div>
            </Wide>
          ) : null}
        </FormCard>
        {/* Reactivation posts to a route with no metadata field, so it is edit-only. */}
        {reactivating ? null : (
          <FormCard title="JSON metadata" columns={1}>
            <MetadataField
              name="metadata_text"
              metadata={metadata}
              editor={metadataEditor}
              onTextChange={(text, valid) => {
                setMetadataText(text);
                setMetadataValid(valid);
              }}
            />
          </FormCard>
        )}
      </SubFormFrame>
    </form>
  );
}
