"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useDefaultState } from "@/lib/use-default-state";
import { cadenceCompatible, cadenceMultiple } from "@/lib/cadence";
import {
  createSubscriptionFullAction,
  estimateNewSubscriptionAction,
  type PickerCustomer,
} from "@/app/actions";
import { CustomerPicker } from "@/components/customers/customer-picker";
import { SummaryBox } from "@/components/patterns/section-card";
import { RecordCard, initials } from "@/components/patterns/record-page";
import { FormCard, MoneyField, SwitchRow, Wide, majorToMinor } from "@/components/catalog/form-kit";
import { toMajorInput } from "@/lib/money";
import {
  ChoiceCardsField,
  FieldBlock,
  FooterFigure,
  ShortLabel,
  SubFormFrame,
} from "@/components/subscriptions/sub-form-frame";
import { Chip, StatusChip } from "@/components/patterns/chip";
import {
  ChangeSummaryDialog,
  type SummaryChargeLine,
} from "@/components/subscriptions/change-summary-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/money-input";
import { DateTimeField } from "@/components/form/datetime-field";
import { useBusinessTz } from "@/components/business-tz";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { money, isQuantityBased, fmtDate, toMajor, toMinor } from "@/lib/format";
import { accountHolderName } from "@/lib/names";
import { cn } from "@/lib/utils";
import { MoreVertical, Plus, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Coupon, Customer, Price, Product, ProductGroup } from "@/lib/api";
import { differentialAmount, type DifferentialRule } from "@/lib/differential";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { makeEstimateLineFormatter } from "@/lib/estimate-lines";
import {
  CouponPickerModal,
  couponDiscountLabel,
  couponDurationLabel,
} from "@/components/subscriptions/coupon-picker-modal";
// The line-item table and the catalog picker are SHARED with the change form —
// both screens render the same table, per the `ui` skill. Style there, not here.
import { CatalogAddModal } from "@/components/subscriptions/catalog-add-modal";
import {
  LineActionLink,
  LineActionSeparator,
  LineActionsBar,
  LineGroupLabel,
  LineItemsCard,
  LineRow,
  lineSubtitle,
} from "@/components/subscriptions/line-items";

export interface PlanAddonRule {
  plan: string; // plan PRODUCT id
  addon: string; // addon PRODUCT id
  level: "mandatory" | "recommended" | "optional";
}

interface Line {
  price: string;
  quantity: number;
  unit_price_minor: string; // minor units; '' = no override
  /** Which section this row renders in (governs its dropdown + grouping). */
  slot: "plan" | "addon" | "charge";
  /** CP-6: auto-included mandatory addon — cannot be removed or re-picked. */
  locked?: boolean;
}

interface EstimateView {
  currency: string;
  lines: Array<{ description: string; amount_minor: number }>;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  /** POST-tax buckets only (refundable + excess) — the promotional slice is pre-tax and
   *  arrives as `promotional_discount_minor`, already netted out of `total_minor`. */
  credits_applied_minor?: number;
  promotional_credits_applied_minor?: number;
  /** Pre-tax promotional discount, already inside `total_minor` (30fcbd6). */
  promotional_discount_minor?: number;
  refundable_credits_applied_minor?: number;
  excess_payments_applied_minor?: number;
  amount_due_minor?: number;
}

/**
 * Standalone inline error for a field that isn't inside a `<Field>` wrapper (e.g.
 * the compact coupon/manual-discount row, which is deliberately one line rather
 * than a stacked label+input). Must be its own component — `useFieldError` reads
 * the nearest `<ActionForm>` provider ABOVE it in the render tree, which only
 * exists for components rendered as children of the form, not for the parent
 * function that returns it.
 */
function InlineFieldError({ name }: { name: string }) {
  const error = useFieldError(name);
  if (!error) return null;
  return <p className="text-xs font-medium text-destructive">{error}</p>;
}

/**
 * Add a catalog interval to a date **in UTC** — a mirror of `addInterval` in
 * `src/modules/subscriptions/service.ts`, month/year clamp included, so the
 * activation date this form previews is the one the engine will actually compute.
 * A trial is configured in `trial_period` + `trial_period_unit`, so assuming days
 * would preview a 1-month trial as ending tomorrow; and `setDate()` reads
 * browser-LOCAL fields, which drifts the boundary by a day either side of UTC.
 */
function addUtcInterval(date: Date, unit: string, count: number): Date {
  const d = new Date(date);
  switch (unit) {
    case "week":
      d.setUTCDate(d.getUTCDate() + 7 * count);
      break;
    case "month":
    case "year": {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      if (unit === "month") d.setUTCMonth(d.getUTCMonth() + count);
      else d.setUTCFullYear(d.getUTCFullYear() + count);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
      break;
    }
    default:
      d.setUTCDate(d.getUTCDate() + count);
  }
  return d;
}

/** "14 days" / "1 month" — a trial length on its own. */
const intervalLabel = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
/** "14-day" / "1-month" — the same length used as an adjective ("a 14-day trial"). */
const intervalAdj = (count: number, unit: string) => `${count}-${unit}`;

/**
 * "New subscription" form: pick-customer modal →
 * line builder (mandatory addons auto-included & locked, recommended one-click)
 * → billing/invoicing sections → live first-invoice estimate rail.
 */
export function SubscriptionCreateForm({
  biz,
  businessName,
  businessCreatePendingInvoices,
  customers,
  prices,
  products,
  productGroups,
  rules,
  differentials,
  coupons,
  initialCustomer,
  error,
}: {
  biz: string;
  businessName: string;
  /** The business's resolved `create_pending_invoices` default — preselected below. */
  businessCreatePendingInvoices: boolean;
  customers: Customer[];
  prices: Price[];
  products: Product[];
  productGroups: ProductGroup[];
  rules: PlanAddonRule[];
  differentials: DifferentialRule[];
  /** Catalog coupons, for the `Add Coupon` picker. Both it and `Add Coupon Code`
   *  land on the same `coupon_code` field. */
  coupons: Coupon[];
  initialCustomer?: string;
  error?: string;
}) {
  const [cus, setCus] = React.useState(initialCustomer ?? "");
  // "Billing Cycles" — Forever (default) or a fixed count applied to the plan
  // line's per-item billing_cycles.
  const [cyclesMode, setCyclesMode] = React.useState<"forever" | "fixed">("forever");
  const [cyclesCount, setCyclesCount] = React.useState("");
  const [showManualDiscount, setShowManualDiscount] = React.useState(false);
  // Coupon. ONE per subscription — `createSubBody` takes a single `coupon_code`, so
  // the Coupons group below can only ever hold one row. Controlled (rather than an
  // uncontrolled `<Input name="coupon_code">`) because the catalog picker has to be
  // able to fill it, and the group row has to be able to render it back.
  const [couponCode, setCouponCode] = React.useState("");
  const [showCouponCode, setShowCouponCode] = React.useState(false);
  /** What's being typed into `Add Coupon Code`, before Apply promotes it. */
  const [couponDraft, setCouponDraft] = React.useState("");
  /** The catalog row for a typed/picked code, when it resolves to a known coupon. */
  const appliedCoupon = coupons.find((c) => c.id === couponCode);
  // Controlled so the value field beside it can switch UNITS: a percent is a plain
  // integer, a fixed amount is money and needs the currency's exponent.
  const [mdType, setMdType] = React.useState("percent");
  /**
   * The manual-discount VALUE, mirrored into state purely so the estimate rail can
   * quote it. The inputs stay uncontrolled and keep posting `md_value` themselves —
   * this is an observer, not the source of truth, which is why the money branch uses
   * `onMinorChange` rather than becoming a controlled field.
   */
  const [mdValue, setMdValue] = React.useState("");
  const [productGroup, setProductGroup] = React.useState("");
  const [startMode, setStartMode] = React.useState<"immediately" | "specific">("immediately");
  const tz = useBusinessTz();
  // UTC ISO, not a wall clock: DateTimeField collects it in the business zone.
  const [startDate, setStartDate] = React.useState("");
  const [trialDays, setTrialDays] = React.useState("");
  // Signup invoicing (`invoice_immediately`). Controlled, because it changes whether
  // ANY money moves on Create — the estimate rail and the confirm dialog have to say so.
  const [invoiceNow, setInvoiceNow] = React.useState(true);
  /** Posted as `auto_collection`; '' inherits the customer's setting. */
  const [autoCollection, setAutoCollection] = React.useState("");
  /** `on_charge_failure`; the engine's default is `refuse`, so that is preselected. */
  const [chargeFailure, setChargeFailure] = React.useState<"refuse" | "dun">("refuse");
  // Controlled so a refused create keeps the pick; re-seeds if the business default moves.
  const [pendingInvoices, setPendingInvoices] = useDefaultState(
    businessCreatePendingInvoices ? "true" : "false",
  );
  const [pickerOpen, setPickerOpen] = React.useState(!initialCustomer);
  const [lines, setLines] = React.useState<Line[]>([]);
  /**
   * Which row has been switched into "pick a different price" mode, and whether that
   * pick is restricted to other cadences of the same product. A row otherwise reads
   * as a record with a ⋮ menu — the same interaction the change form uses, rather
   * than an always-open dropdown on one screen and a menu on the other.
   */
  const [editingRow, setEditingRow] = React.useState<{ index: number; freqOnly: boolean } | null>(
    null,
  );
  const [estimate, setEstimate] = React.useState<EstimateView | null>(null);
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
  const [estimating, startEstimate] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const priceById = React.useMemo(() => new Map(prices.map((p) => [p.id, p])), [prices]);
  const kindOf = (priceId: string) => {
    const pr = priceById.get(priceId);
    return pr ? (productById.get(pr.product)?.kind ?? "plan") : null;
  };
  const priceLabel = (p: Price) => {
    const prod = productById.get(p.product);
    return `${prod?.name ?? p.product} · ${p.currency} ${p.amount_minor != null ? money(p.amount_minor, p.currency) : p.model}${p.interval ? `/${p.interval}` : ""}`;
  };
  // Only one plan slot exists in this form, so its price is what fixes the
  // subscription's currency — computed before `pricesByKind` so that filter can
  // constrain add-ons/charges to match it (see below).
  const planPrice = lines
    .map((l) => priceById.get(l.price))
    .find((p) => p && productById.get(p.product)?.kind === "plan");

  /**
   * Once a plan is chosen, its currency fixes the subscription's: the engine
   * refuses a mixed-currency request (`Mixed currencies in one subscription: …`,
   * src/modules/subscriptions/service.ts createSubscription), so add-on/charge
   * options are restricted to it — otherwise the operator could fill in the whole
   * form and only discover the rejection on submit. The plan dropdown itself stays
   * unconstrained (it's the one thing that SETS the currency); before any plan is
   * picked, everything is offered.
   */
  /**
   * A non-plan price is offerable only if its cadence fits the plan's cycle — exact,
   * or a shorter period that divides it (a monthly add-on on a yearly plan bills
   * ×12 once a year). The engine refuses anything else, so offering it here would
   * just defer the rejection to submit, exactly as a mismatched currency would.
   */
  const cadenceFitsPlan = (p: Price): boolean =>
    !planPrice ||
    cadenceCompatible(
      { interval: planPrice.interval, interval_count: planPrice.interval_count },
      { interval: p.interval, interval_count: p.interval_count, model: p.model, type: p.type },
    );

  const pricesByKind = (kind: string) =>
    prices.filter(
      (p) =>
        p.active !== false &&
        (productById.get(p.product)?.kind ?? "plan") === kind &&
        (kind === "plan" || !planPrice || p.currency === planPrice.currency) &&
        (kind === "plan" || cadenceFitsPlan(p)),
    );

  // The shared resolver rather than a fourth hand-rolled copy of the chain: the `||
  // c.name` arm only ever added `company`, and `customers.name` is deprecated — the
  // wire's `name` is now derived from exactly the fields checked on its left.
  const customerLabel = (c: Customer) => accountHolderName(c) ?? c.id;
  /** The server-fetched first page, in picker shape — what the dialog shows before a query. */
  const initialCustomerRows: PickerCustomer[] = React.useMemo(
    () =>
      customers.map((c) => ({
        id: c.id,
        label: customerLabel(c),
        sub: c.email ?? null,
        effective_currency: c.effective_currency ?? null,
        auto_collection: (c.auto_collection as "on" | "off" | null | undefined) ?? null,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customers],
  );
  /**
   * The chosen customer, held in STATE rather than looked up in `customers`.
   *
   * `customers` is now the first page, not a 1000-row read, so a customer reached
   * through the picker's server search is not in it — `customers.find(...)` would have
   * come back undefined and the auto-collection prose below would have rendered its
   * "unknown" arm for a customer whose setting we do in fact know.
   */
  const [pickedCustomer, setPickedCustomer] = React.useState<PickerCustomer | null>(null);
  const selectedCustomer: PickerCustomer | null =
    pickedCustomer && pickedCustomer.id === cus
      ? pickedCustomer
      : (initialCustomerRows.find((c) => c.id === cus) ?? null);
  /**
   * The auto-collection the subscription will INHERIT if the operator leaves the
   * control alone. The resolved value is named ("Auto collection is turned ON now")
   * rather than a generic "uses the customer's setting" — the whole point of
   * the inherit option is that you can see what you are inheriting. `serializeCustomer`
   * puts `auto_collection` on the list rows too, so this is the real stored value,
   * not a guess. `createSubscription` defaults an omitted field to the customer's.
   */
  const inheritedAutoCollection = selectedCustomer?.auto_collection ?? null;

  // ── CP-6: addon applicability for the currently selected plan lines ────────
  const planProductIds = lines
    .filter((l) => l.price && kindOf(l.price) === "plan")
    .map((l) => priceById.get(l.price)?.product)
    .filter(Boolean) as string[];

  // CP-6: the set of addon PRODUCT ids applicable to the selected plan(s). Used to
  // hard-filter the addon dropdown so you can only attach add-ons
  // compatible with the plan.
  const applicableAddonIds = React.useMemo(
    () => new Set(rules.filter((r) => planProductIds.includes(r.plan)).map((r) => r.addon)),
    [rules, planProductIds.join(",")],
  );
  const isAddonApplicable = (priceId: string): boolean => {
    const pr = priceById.get(priceId);
    return pr ? applicableAddonIds.has(pr.product) : true;
  };
  /** Addon options are gated by plan applicability; plans/charges are shown as-is. */
  const optionsForKind = (kind: string): Price[] =>
    kind === "addon"
      ? pricesByKind("addon").filter((p) => applicableAddonIds.has(p.product))
      : pricesByKind(kind);

  /**
   * Effective per-unit price for a line, in minor units. Explicit override wins;
   * otherwise an addon uses its plan-specific differential price (CAT-7) when one
   * is configured, falling back to the catalog list price.
   */
  const effectiveUnitMinor = (l: { price: string; unit_price_minor: string }): number => {
    const price = priceById.get(l.price);
    if (!price) return 0;
    const base = (): number => {
      if (l.unit_price_minor !== "") return Number(l.unit_price_minor);
      if (kindOf(l.price) === "addon") {
        const diff = differentialAmount(
          differentials,
          price.product,
          planPrice?.product,
          price.currency,
          price.interval,
        );
        if (diff != null) return diff;
      }
      return price.amount_minor ?? 0;
    };
    // Then folded into the plan's cycle, in that order — the rate comes from the
    // override/differential, `cadenceMultiple` scales it (₹475/mo on a yearly plan
    // → ₹5,700). Matches `alignSnapshotToCycle` on the engine side.
    return base() * cadenceScale(l.price);
  };

  /**
   * What the dialog should PRICE a candidate at — the same differential resolution the
   * line will get. Not folded into the plan's cycle: the dialog is offering the item's
   * own cadence, and the ×N belongs to the line once it exists.
   */
  const effectiveCatalogAmount = (price: Price): number | null => {
    const diff = differentialAmount(
      differentials,
      price.product,
      planPrice?.product,
      price.currency,
      price.interval,
    );
    return diff ?? price.amount_minor ?? null;
  };

  /** ×N for a shorter-cadence non-plan item, else 1. */
  const cadenceScale = (priceId: string): number => {
    const p = priceById.get(priceId);
    if (!p || !planPrice || kindOf(priceId) === "plan" || p.type !== "recurring") return 1;
    return (
      cadenceMultiple(
        { interval: planPrice.interval, interval_count: planPrice.interval_count },
        { interval: p.interval, interval_count: p.interval_count },
      ) ?? 1
    );
  };

  /**
   * Best price for an addon product: the plan's currency + interval, else the same
   * currency on a cadence that still FITS the plan's cycle (divides it, ×N).
   *
   * The old last resort was `candidates[0]` — any currency, any cadence — which is
   * how a required add-on could auto-attach a price the engine then refused, on a
   * row the operator cannot remove (`locked: true`). Returning undefined instead
   * leaves the add-on unselected and the row visibly empty, which is honest: there
   * is no price for it on this plan's cycle.
   */
  const bestAddonPrice = React.useCallback(
    (addonProductId: string): Price | undefined => {
      const candidates = prices.filter((p) => p.product === addonProductId && p.active !== false);
      const sameCurrency = candidates.filter((p) => p.currency === planPrice?.currency);
      return (
        sameCurrency.find((p) => p.interval === planPrice?.interval) ??
        sameCurrency.find((p) =>
          cadenceCompatible(
            { interval: planPrice?.interval ?? null, interval_count: planPrice?.interval_count },
            {
              interval: p.interval,
              interval_count: p.interval_count,
              model: p.model,
              type: p.type,
            },
          ),
        ) ??
        (planPrice ? undefined : candidates[0])
      );
    },
    [prices, planPrice?.currency, planPrice?.interval, planPrice?.interval_count],
  );

  const requiredAddonPrices = React.useMemo(() => {
    const out = new Map<string, string>(); // price id → addon product id
    for (const plan of planProductIds) {
      for (const r of rules) {
        if (r.plan === plan && r.level === "mandatory") {
          const price = bestAddonPrice(r.addon);
          if (price) out.set(price.id, r.addon);
        }
      }
    }
    return out;
  }, [planProductIds.join(","), rules, bestAddonPrice]);

  const recommendedAddons = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ product: Product; price: Price }> = [];
    for (const plan of planProductIds) {
      for (const r of rules) {
        if (r.plan === plan && r.level === "recommended" && !seen.has(r.addon)) {
          seen.add(r.addon);
          const price = bestAddonPrice(r.addon);
          const product = productById.get(r.addon);
          if (price && product && !lines.some((l) => l.price === price.id))
            out.push({ product, price });
        }
      }
    }
    return out;
  }, [planProductIds.join(","), rules, bestAddonPrice, lines, productById]);

  // Keep mandatory addon lines in sync with the selected plan(s).
  React.useEffect(() => {
    setLines((ls) => {
      const kept = ls.filter((l) => !l.locked || requiredAddonPrices.has(l.price));
      const present = new Set(kept.map((l) => l.price));
      const added = [...requiredAddonPrices.keys()]
        .filter((priceId) => !present.has(priceId))
        .map((priceId) => ({
          price: priceId,
          quantity: 1,
          unit_price_minor: "",
          slot: "addon" as const,
          locked: true,
        }));
      // Unlock nothing; mark existing manual duplicates as locked instead of duplicating.
      const merged = kept.map((l) =>
        requiredAddonPrices.has(l.price) ? { ...l, locked: true } : l,
      );
      if (added.length === 0 && merged.every((l, i) => l === kept[i])) return ls;
      return [...merged, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [[...requiredAddonPrices.keys()].join(",")]);

  const [currencyClearedNotice, setCurrencyClearedNotice] = React.useState<string | null>(null);
  // If the plan is swapped to a price in a DIFFERENT currency after add-ons/charges
  // were already picked, those lines must not silently ride along into a request the
  // engine will reject (`Mixed currencies in one subscription`) — drop them and say
  // so, rather than let the form look complete and fail only on Create.
  React.useEffect(() => {
    const cur = planPrice?.currency;
    if (!cur) return;
    const dropped = lines.filter(
      (l) => l.slot !== "plan" && l.price && priceById.get(l.price)?.currency !== cur,
    );
    if (dropped.length === 0) return;
    setLines((ls) =>
      ls.filter((l) => l.slot === "plan" || !l.price || priceById.get(l.price)?.currency === cur),
    );
    setCurrencyClearedNotice(
      `Removed ${dropped.length} line${dropped.length > 1 ? "s" : ""} priced in a different currency. A subscription cannot mix currencies, and the plan uses ${cur}.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planPrice?.currency]);

  const validLines = lines.filter((l) => l.price);
  const itemsJson = JSON.stringify(
    validLines.map((l) => ({
      price: l.price,
      quantity: l.quantity || 1,
      ...(l.unit_price_minor !== "" ? { unit_price_minor: Number(l.unit_price_minor) } : {}),
      ...(cyclesMode === "fixed" && Number(cyclesCount) > 0 && kindOf(l.price) === "plan"
        ? { billing_cycles: Number(cyclesCount) }
        : {}),
    })),
  );

  // Refresh the estimate whenever customer or lines change (debounced).
  React.useEffect(() => {
    if (!cus || validLines.length === 0) {
      setEstimate(null);
      setEstimateError(null);
      return;
    }
    const t = setTimeout(() => {
      startEstimate(async () => {
        const res = await estimateNewSubscriptionAction(
          biz,
          cus,
          validLines.map((l) => ({
            price: l.price,
            quantity: l.quantity || 1,
            ...(l.unit_price_minor !== "" ? { unit_price_minor: Number(l.unit_price_minor) } : {}),
          })),
          // The applied coupon is part of what is being previewed. Without it the rail
          // quoted list price next to a line list already showing the discount, and the
          // tax figure was computed on the undiscounted subtotal as well.
          couponCode || undefined,
          // A percent posts a plain integer; an amount posts integer MINOR units. Both
          // ride `md_value`, so the unit is `mdType` — which is why switching it clears
          // the mirror.
          mdValue !== "" && Number(mdValue) > 0
            ? {
                type: mdType === "amount" ? ("amount" as const) : ("percent" as const),
                value: Number(mdValue),
                duration: "one_time" as const,
              }
            : undefined,
        );
        if (res.ok) {
          setEstimate(res.estimate as EstimateView);
          setEstimateError(null);
        } else {
          setEstimate(null);
          setEstimateError(res.error);
        }
      });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `couponCode` belongs in here: applying or clearing a coupon changes the quote, and
    // without it the rail kept showing the pre-coupon total until an unrelated edit.
  }, [
    biz,
    cus,
    couponCode,
    mdType,
    mdValue,
    JSON.stringify(validLines.map((l) => [l.price, l.quantity, l.unit_price_minor])),
  ]);

  const upd = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = (slot: "addon" | "charge", price = "") =>
    setLines((ls) => [...ls, { price, quantity: 1, unit_price_minor: "", slot }]);
  /** A catalog pick lands here. Only one plan slot exists, so a plan replaces it. */
  const addCatalogPrice = (slot: "plan" | "addon" | "charge", priceId: string) =>
    setLines((ls) =>
      slot === "plan"
        ? [
            ...ls.filter((l) => l.slot !== "plan"),
            { price: priceId, quantity: 1, unit_price_minor: "", slot },
          ]
        : [...ls, { price: priceId, quantity: 1, unit_price_minor: "", slot }],
    );
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));
  const hasPlan = validLines.some((l) => kindOf(l.price) === "plan");

  // ─── Catalog picker inputs (the modal itself is shared with the change form) ──
  /** Candidate PRODUCTS of one kind, with this form's group/applicability filters. */
  const catalogProducts = (kind: "plan" | "addon" | "charge"): Product[] =>
    products.filter((p) => {
      if (p.active === false || p.kind !== kind) return false;
      if (kind === "plan" && productGroup && p.product_group !== productGroup) return false;
      if (kind === "addon" && planProductIds.length > 0 && !applicableAddonIds.has(p.id))
        return false;
      return true;
    });
  /**
   * The prices of a product that may legally be attached: the plan fixes the
   * subscription's currency and cycle, so an add-on/charge is offered only in that
   * currency and on a cadence that divides the plan's — the same constraint
   * `pricesByKind` applies to the row dropdowns, so the two can't disagree.
   */
  const catalogPricesFor =
    (kind: "plan" | "addon" | "charge") =>
    (productId: string): Price[] =>
      prices.filter(
        (p) =>
          p.product === productId &&
          p.active !== false &&
          (kind === "plan" || !planPrice || p.currency === planPrice.currency) &&
          (kind === "plan" || cadenceFitsPlan(p)),
      );

  // ─── Grouping + row rendering (sections) ─────────────────────────────────────
  const indexed = lines.map((l, i) => ({ l, i }));
  const planRows = indexed.filter(({ l }) => l.slot === "plan");
  const addonRows = indexed.filter(({ l }) => l.slot === "addon");
  const chargeRows = indexed.filter(({ l }) => l.slot === "charge");

  /**
   * Price-per-unit input adapter: the field edits MAJOR units; state stays minor.
   * The conversion goes through `lib/money.ts` rather than a literal 100 — a line
   * priced in JPY has no minor unit, so ÷100 showed ¥1000 as 10 and posted 100000.
   * The line's own currency drives the exponent, falling back to the form's.
   */
  const lineCurrency = (l?: Line): string =>
    (l ? priceById.get(l.price)?.currency : undefined) ?? planPrice?.currency ?? "";
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

  const renderRow = (l: Line, i: number) => {
    const price = l.price ? priceById.get(l.price) : undefined;
    const prod = price ? productById.get(price.product) : undefined;
    const lineTotal = effectiveUnitMinor(l) * (l.quantity || 1);
    const incompatible = l.slot === "addon" && l.price !== "" && !isAddonApplicable(l.price);
    const isPlan = l.slot === "plan";
    const qtyBased = isQuantityBased(price?.model);

    // One price picker covers both "change plan" and "change frequency", so the menu
    // item decides what it may offer — every plan price, or only the OTHER cadences
    // of the plan already chosen.
    const editing = editingRow?.index === i;
    const sameProductOtherCadence =
      price && isPlan
        ? pricesByKind("plan").filter((p) => p.product === price.product && p.id !== price.id)
        : [];
    const options =
      editing && editingRow?.freqOnly
        ? sameProductOtherCadence
        : isPlan
          ? pricesByKind("plan").filter(
              (p) => !productGroup || productById.get(p.product)?.product_group === productGroup,
            )
          : l.slot === "charge"
            ? pricesByKind("charge")
            : optionsForKind("addon");
    const optionInList = l.price ? options.some((p) => p.id === l.price) : true;

    // A chosen row reads as a record — you open the ⋮ menu to change it, exactly as
    // on the change form. Only a row without a price yet shows its picker up front.
    const showPicker = editing || !l.price;
    // A quantity-INVARIANT price (flat) has no meaningful unit×qty split, so both are
    // dashed and the AMOUNT is the editable field; a per-unit one edits price + qty.
    const amountIsEditable = !qtyBased && !!l.price;

    return (
      <LineRow
        key={`${l.slot}-${i}`}
        name={prod?.name ?? price?.product ?? (isPlan ? "Plan" : l.slot)}
        subtitle={lineSubtitle(price?.interval, l.slot)}
        badges={
          incompatible || l.locked ? (
            <>
              {incompatible ? (
                <Chip tone="red" className="px-1.5 py-0 text-xs uppercase">
                  Not applicable
                </Chip>
              ) : null}
              {/* A mandatory add-on the plan pulled in: no remove control at all, because
                  dropping it would be rejected on submit. */}
              {l.locked ? <Chip className="px-1.5 py-0 text-xs">Required</Chip> : null}
            </>
          ) : null
        }
        picker={
          showPicker ? (
            <SelectField
              value={l.price}
              onValueChange={(v) => {
                const np = priceById.get(v);
                upd(i, { price: v, ...(np && !isQuantityBased(np.model) ? { quantity: 1 } : {}) });
                setEditingRow(null);
              }}
              disabled={l.locked}
              className={cn("w-full min-w-0 font-medium", l.locked && "opacity-70")}
              ariaLabel={`${l.slot} for line ${i + 1}`}
              placeholder={
                isPlan ? "Select plan…" : l.slot === "charge" ? "Select charge…" : "Select add-on…"
              }
              options={[
                ...options.map((p) => ({ value: p.id, label: priceLabel(p) })),
                // A price that is set but no longer in the filtered list still has to
                // render, or the row would silently look empty.
                ...(l.price && !optionInList
                  ? [{ value: l.price, label: priceLabel(price!) }]
                  : []),
              ]}
            />
          ) : null
        }
        currency={price?.currency ?? planPrice?.currency ?? ""}
        qtyBased={qtyBased}
        quantity={l.quantity}
        onQuantityChange={(q) => upd(i, { quantity: q })}
        unitValue={unitFieldValue(l)}
        onUnitChange={(v) => onUnitFieldChange(i, v)}
        unitDisabled={!l.price}
        amountMinor={price ? lineTotal : null}
        amountEditable={amountIsEditable}
        actions={
          // Locked rows say "Required" beside the name; the 2rem actions track has no
          // room for text.
          l.locked ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-8 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Actions for ${prod?.name ?? l.slot}`}
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isPlan ? (
                  <>
                    <DropdownMenuItem onSelect={() => setEditingRow({ index: i, freqOnly: false })}>
                      Change Plan
                    </DropdownMenuItem>
                    {/* Only offered when another cadence of this plan actually exists. */}
                    {sameProductOtherCadence.length > 0 ? (
                      <DropdownMenuItem
                        onSelect={() => setEditingRow({ index: i, freqOnly: true })}
                      >
                        Change Frequency
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => setEditingRow({ index: i, freqOnly: false })}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => removeLine(i)}>
                      Remove
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
    );
  };

  // ─── Trial resolution: MIRROR THE ENGINE, not the input box ─────────────────
  // `createSubBody.trial_days` (src/api/subscription-routes.ts) is OPTIONAL, and
  // `createSubscription` (src/modules/subscriptions/service.ts) resolves three cases:
  //   omitted → AUTO-APPLY the plan price's configured `trial_period`
  //   === 0   → explicit no-trial, even when the plan configures one
  //   > 0     → a trial of N DAYS, overriding the plan's
  // This preview used to derive `inTrial` from the `Trial days` box ALONE, which starts
  // empty — so a plan carrying `trial_period: 14` previewed as "₹9,215.00 chargeable
  // immediately" and went to `active`, while the engine opened an `in_trial`
  // subscription and charged ₹0. The operator was shown a charge that never happened.
  // The trial is inherited from the FIRST RECURRING line, which is exactly how the
  // engine picks it (`items.find((i) => i.price.type === 'recurring')`); `lines[0]` is
  // the plan slot, so that is the plan the operator chose.
  const trialSourcePrice = validLines
    .map((l) => priceById.get(l.price))
    .find((p) => p?.type === "recurring");
  const planTrialCount = trialSourcePrice?.trial_period ?? 0;
  const planTrialUnit = trialSourcePrice?.trial_period_unit || "day";
  /** '' (the default) = post nothing and inherit; a number = an explicit override. */
  const trialOverride = trialDays.trim() === "" ? null : Number(trialDays);
  /** The effective trial the engine will apply, or null for none. */
  const trial: { count: number; unit: string; fromPlan: boolean } | null =
    trialOverride === 0
      ? null
      : trialOverride != null && trialOverride > 0
        ? { count: trialOverride, unit: "day", fromPlan: false }
        : planTrialCount > 0
          ? { count: planTrialCount, unit: planTrialUnit, fromPlan: true }
          : null;
  const inTrial = trial !== null;

  // `startDate` is a UTC ISO instant (DateTimeField), and it only POSTS while the mode
  // is "specific" — a date typed and then abandoned must not move the preview either.
  const startIso = startMode === "specific" && startDate ? startDate : "";
  // A future-dated start parks the subscription in `future` and raises no invoice now
  // (`isFuture` in createSubscription), trial or not.
  const startsInFuture = startIso !== "" && new Date(startIso).getTime() > Date.now();
  const toStatus = startsInFuture ? "future" : inTrial ? "in_trial" : "active";
  /**
   * True when NO first invoice is raised at all — a trial or a future-dated start.
   * This is what gates the `invoice_immediately` control's visibility, so it must NOT
   * fold in that control's own value or the control would hide itself when switched off.
   */
  const chargesLater = inTrial || startsInFuture;
  /**
   * The subscription starts active NOW but its first period was deferred to unbilled
   * charges (`invoice_immediately: false`) — so there is no invoice and nothing is
   * collected today either.
   */
  const firstInvoiceDeferred = !chargesLater && !invoiceNow;
  /** Nothing leaves the card on Create — the headline must then read 0. */
  const nothingDueNow = chargesLater || firstInvoiceDeferred;
  /** A charge is taken on Create, so the failed-charge choice has an effect. */
  const chargesOnCreate =
    !nothingDueNow &&
    hasPlan &&
    (estimate?.amount_due_minor ?? 1) > 0 &&
    (autoCollection === "" ? inheritedAutoCollection === "on" : autoCollection === "on");
  const activationDate = React.useMemo(() => {
    const base = startIso ? new Date(startIso) : new Date();
    return trial ? addUtcInterval(base, trial.unit, trial.count) : base;
  }, [startIso, trial?.unit, trial?.count]);
  const activationLabel = fmtDate(activationDate.toISOString(), tz);

  // ─── Estimate lines: show the plan, not the slug ────────────────────────────
  // The API describes a first-invoice line as `flat (<price-handle>) ×1`
  // (`estimateNewSubscription`, src/modules/subscriptions/estimate.ts) — our internal
  // catalog handle, on the screen an operator reads out loud. The formatter swaps it
  // for the price's display name and lifts the `×N` out into a Units column.
  const lineFormatter = React.useMemo(
    () => makeEstimateLineFormatter(priceById, productById),
    [priceById, productById],
  );
  /**
   * Service period for a first-invoice line — printed under the item name.
   * Only for RECURRING prices, and only via `addUtcInterval`, the same mirror of the
   * engine's `addInterval` that fixes `activationDate` above; a one-time fee buys no
   * span of time, so it gets no period rather than an invented one.
   */
  const linePeriod = (priceId: string | null): string | null => {
    const p = priceId ? priceById.get(priceId) : undefined;
    if (!p || p.type !== "recurring" || !p.interval) return null;
    // A shorter-cadence item is FOLDED into the subscription's cycle, so it buys the
    // whole cycle, not its own period: a monthly add-on on a yearly plan is billed
    // ×12 up front and its service period is the year. Printing the add-on's own
    // month here claimed a span the invoice does not cover; every invoice line shows
    // the subscription's period.
    const interval = cadenceScale(priceId!) > 1 ? planPrice!.interval : p.interval;
    const count =
      cadenceScale(priceId!) > 1 ? (planPrice!.interval_count ?? 1) : (p.interval_count ?? 1);
    if (!interval) return null;
    const end = addUtcInterval(activationDate, interval, count);
    return `${fmtDate(activationDate.toISOString(), tz)} – ${fmtDate(end.toISOString(), tz)}`;
  };
  const estimateCharges: SummaryChargeLine[] = (estimate?.lines ?? []).map((l) => ({
    ...lineFormatter.view(l),
    period: linePeriod(lineFormatter.priceIdIn(l.description)),
  }));

  const estCurrency = planPrice?.currency ?? estimate?.currency ?? "";
  /** What the first invoice will come to, whenever it is raised. */
  const estTotalMinor = estimate?.amount_due_minor ?? estimate?.total_minor ?? 0;
  const headlineLabel = inTrial
    ? `Nothing due now. We charge ${money(estTotalMinor, estCurrency)} ${estCurrency} when the trial ends on ${activationLabel}`
    : startsInFuture
      ? `Nothing due now. We charge when the subscription starts on ${activationLabel}`
      : firstInvoiceDeferred
        ? `Nothing due now. ${money(estTotalMinor, estCurrency)} ${estCurrency} goes to unbilled charges and is added to the next invoice`
        : "Chargeable immediately";

  const footerNote = "Create asks you to confirm before we charge anything";
  const breakdownNote = inTrial
    ? `We charge nothing on create. The first invoice contains these charges when the trial ends on ${activationLabel}.`
    : startsInFuture
      ? `We charge nothing on create. The first invoice contains these charges when the subscription starts on ${activationLabel}.`
      : firstInvoiceDeferred
        ? "We invoice nothing on create. These charges go to unbilled charges and are added to the next invoice."
        : "Summary of the charges that we raise on create.";

  const amountRow = (label: React.ReactNode, value: React.ReactNode, className?: string) => (
    <div className={cn("flex items-baseline justify-between gap-3 text-sm", className)}>
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );

  const preview = (
    <RecordCard title="First invoice preview">
      <div className="flex flex-col gap-3">
        {estimating ? <p className="text-sm text-muted-foreground">Estimating…</p> : null}
        {estimateError ? <p className="text-sm text-destructive">{estimateError}</p> : null}
        {/* Ask only for what is actually missing — this form is routinely reached
            with the customer already chosen (`?customer=<id>` → `initialCustomer`). */}
        {!estimate && !estimating && !estimateError ? (
          <p className="text-sm text-muted-foreground">
            {!cus && !hasPlan
              ? "Select a customer and a plan to preview the first invoice."
              : !cus
                ? "Select a customer to preview the first invoice."
                : "Select a plan to preview the first invoice."}
          </p>
        ) : null}
        {estimate ? (
          <>
            <div>
              <StatusChip status={toStatus} />
            </div>
            {inTrial ? (
              <p className="text-xs text-muted-foreground">
                {/* Where the trial CAME from: an inherited trial must be visible rather
                    than implicit — an operator who never touched the Trial days box has
                    no other way to know one applies. */}
                {trial!.fromPlan
                  ? `${intervalAdj(trial!.count, trial!.unit)} trial from this plan. The subscription activates on `
                  : `${intervalAdj(trial!.count, trial!.unit)} trial. The subscription activates on `}
                <b>{activationLabel}</b>.
              </p>
            ) : startsInFuture ? (
              <p className="text-xs text-muted-foreground">
                The subscription starts on <b>{activationLabel}</b>. We charge nothing now.
              </p>
            ) : firstInvoiceDeferred ? (
              <p className="text-xs text-muted-foreground">
                First invoice deferred. These charges go to <b>unbilled charges</b> and are added to
                the next invoice. We charge nothing now.
              </p>
            ) : null}
            <div
              className={cn(
                "space-y-2 rounded-lg border p-4",
                // No money moves on Create when it charges later, so this must not read
                // as an alert (a fill is for things that need action now).
                nothingDueNow ? "border-info/25 bg-info-soft" : "border-warning/25 bg-warning-soft",
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
                {/* "Nothing due now" as the HEADLINE when nothing moves, with the deferred
                    figure underneath — the same shape the change rail uses. */}
                {nothingDueNow ? (
                  <div className="min-w-0">
                    <div className="text-xl font-bold text-foreground">Nothing due now</div>
                    <div className="mt-0.5 text-xs font-medium wrap-break-word text-muted-foreground">
                      <span className="tabular-nums">
                        {money(estTotalMinor, estimate.currency)} {estimate.currency}
                      </span>{" "}
                      {inTrial
                        ? `charges when the trial ends on ${activationLabel}`
                        : startsInFuture
                          ? `charges when the subscription starts on ${activationLabel}`
                          : "goes to unbilled charges and is added to the next invoice"}
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0">
                    <div className="text-xl font-bold wrap-anywhere text-foreground tabular-nums">
                      {money(estTotalMinor, estimate.currency)} {estimate.currency}
                    </div>
                    <div className="mt-0.5 text-xs font-medium text-muted-foreground">
                      Chargeable immediately
                    </div>
                  </div>
                )}
              </div>
              {(estimate.refundable_credits_applied_minor ?? estimate.credits_applied_minor ?? 0) >
              0 ? (
                <div className="flex items-center gap-2 pt-1 text-xs font-medium text-foreground">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-xs font-bold text-background">
                    ✓
                  </span>
                  <span>
                    {money(
                      estimate.refundable_credits_applied_minor ??
                        estimate.credits_applied_minor ??
                        0,
                      estimate.currency,
                    )}{" "}
                    {estimate.currency} refundable credits applied
                  </span>
                </div>
              ) : null}
            </div>

            {/* The breakdown, inline: items → subtotal → promotional credit (pre-tax) →
                tax → total → balance credits → amount due. */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <span>Items</span>
                <span>Amount ({estimate.currency})</span>
              </div>
              {estimate.lines.map((l, i) => (
                <React.Fragment key={i}>
                  {amountRow(
                    <span className="text-muted-foreground">
                      {lineFormatter.describe(l.description)}
                    </span>,
                    money(l.amount_minor, estimate.currency),
                  )}
                </React.Fragment>
              ))}
              {amountRow(
                "Subtotal",
                money(estimate.subtotal_minor, estimate.currency),
                "mt-1 border-t pt-2 font-medium",
              )}
              {/* ABOVE tax: promotional credit is applied pre-tax and shrinks the taxable
                  base, so the tax row beneath is charged on what is left after it. */}
              {(estimate.promotional_discount_minor ?? 0) > 0
                ? amountRow(
                    "Promotional credits",
                    `−${money(estimate.promotional_discount_minor ?? 0, estimate.currency)}`,
                    "text-success",
                  )
                : null}
              {estimate.tax_minor > 0
                ? amountRow(
                    "Tax",
                    money(estimate.tax_minor, estimate.currency),
                    "text-muted-foreground",
                  )
                : null}
              {amountRow("Total", money(estimate.total_minor, estimate.currency))}
              {(estimate.credits_applied_minor ?? 0) > 0 ? (
                <>
                  {amountRow(
                    "Credits applied from balance",
                    `−${money(estimate.credits_applied_minor ?? 0, estimate.currency)}`,
                    "text-success",
                  )}
                  {amountRow(
                    "Amount due",
                    money(estimate.amount_due_minor ?? estimate.total_minor, estimate.currency),
                    "border-t pt-2 font-semibold",
                  )}
                </>
              ) : null}
              <p className="pt-1 text-xs text-muted-foreground">{breakdownNote}</p>
            </div>

            {/* `activationDate` is "now" once the subscription starts active, so this
                line only tells the truth while the first invoice IS the next one. With
                the first period deferred to unbilled charges the next invoice is the
                renewal, a date this form does not compute — so say nothing. */}
            {firstInvoiceDeferred ? null : (
              <p className="text-xs text-muted-foreground">
                We raise the next invoice of <b>{money(estimate.total_minor, estimate.currency)}</b>{" "}
                on <b>{activationLabel}</b>.
              </p>
            )}
            <SummaryBox>
              Usage-model items bill in arrears and are not included. A trial moves the first charge
              to the trial end.
            </SummaryBox>
          </>
        ) : null}
      </div>
    </RecordCard>
  );

  return (
    <ActionForm
      action={createSubscriptionFullAction}
      formRef={formRef}
      onSuccess={(r) => r.redirectTo && router.push(r.redirectTo)}
    >
      <ChangeSummaryDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Create subscription?"
        toStatus={toStatus}
        charges={estimateCharges}
        currency={estCurrency}
        headlineMinor={nothingDueNow ? 0 : estTotalMinor}
        headlineLabel={headlineLabel}
        // Nothing moves on confirmation for a trial, a future start, or a deferred first
        // invoice, so the headline must not read as an alert — and the charges table is
        // not "immediate".
        headlineTone={nothingDueNow ? "info" : "warning"}
        chargesLabel={
          inTrial
            ? "Charges at trial end"
            : startsInFuture
              ? "Charges when it starts"
              : firstInvoiceDeferred
                ? "Charges on the next invoice"
                : "Immediate charges"
        }
        taxMinor={estimate?.tax_minor}
        loading={estimating}
        emptyNote="No immediate charge. Add a plan to preview charges."
        proceedDisabled={!cus || !hasPlan}
        proceedLabel="Create subscription"
        onProceed={() => formRef.current?.requestSubmit()}
      />
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <input type="hidden" name="items" value={itemsJson} />

      {/* Pick a customer — an entry modal, searching the SERVER. It used to filter the
          `customers` prop, which was a `limit: 1000` bulk read, so customer 1001 was
          unfindable and said nothing about it. */}
      <CustomerPicker
        biz={biz}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initial={initialCustomerRows}
        onSelect={(c) => {
          setCus(c.id);
          setPickedCustomer(c);
        }}
        description="Select the customer for this subscription."
      />

      <SubFormFrame
        crumbs={[
          { label: businessName, href: `/businesses/${biz}` },
          { label: "Subscriptions", href: `/businesses/${biz}/subscriptions` },
          { label: "New subscription" },
        ]}
        title="New subscription"
        description="Select the customer and the plan. The preview shows what Create will invoice."
        status={error ? <ErrorState description={error} /> : null}
        cancelHref={`/businesses/${biz}/subscriptions`}
        footerNote={footerNote}
        footerFigure={
          <FooterFigure
            label="Due now"
            value={estimate ? money(nothingDueNow ? 0 : estTotalMinor, estimate.currency) : "—"}
          />
        }
        primary={
          <Button type="button" disabled={!cus || !hasPlan} onClick={() => setConfirmOpen(true)}>
            <ShortLabel full="Create subscription" short="Create" />
          </Button>
        }
        aside={preview}
      >
        <RecordCard title="Customer">
          {cus ? (
            <div className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
              >
                {initials(selectedCustomer?.label ?? cus)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium wrap-anywhere">
                  {selectedCustomer?.label ?? cus}
                </div>
                <div className="text-xs wrap-anywhere text-muted-foreground">
                  {selectedCustomer?.sub && selectedCustomer.sub !== selectedCustomer.label ? (
                    <>{selectedCustomer.sub} · </>
                  ) : null}
                  <span className="font-mono">{cus}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto shrink-0 p-0"
                onClick={() => setPickerOpen(true)}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">Select who this subscription bills.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <UserRound className="size-4" />
                Select a customer
              </Button>
            </div>
          )}
        </RecordCard>

        <RecordCard title="Items" meta={planPrice?.currency} flush>
          <div className="flex flex-col gap-3 px-5 py-4">
            {/* There is no subscription-level product group — the group is whatever
                the chosen plan's product belongs to — so this control POSTS NOTHING:
                it only narrows the plan dropdown below. It used to carry a required
                asterisk while defaulting to "All product groups", i.e. a required
                field whose default is a non-answer and whose value never leaves the
                page. Labelled for what it actually is instead of removed, because the
                filtering is genuinely useful on a large catalog. To make it a real
                posted field, add a group column to the subscription first. */}
            {productGroups.length > 0 ? (
              <FieldBlock
                label="Filter plans by product group"
                help={
                  <>
                    Narrows the plan list below. The subscription&rsquo;s group follows the plan you
                    pick.
                  </>
                }
                className="max-w-sm"
              >
                <SelectField
                  value={productGroup}
                  onValueChange={setProductGroup}
                  ariaLabel="Filter plans by product group"
                  options={[
                    { value: "", label: "All product groups" },
                    ...productGroups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
              </FieldBlock>
            ) : null}
            {currencyClearedNotice ? (
              <Alert tone="warning">{currencyClearedNotice}</Alert>
            ) : planPrice ? (
              <p className="text-xs text-muted-foreground">
                Showing {planPrice.currency} items. A subscription cannot mix currencies.
              </p>
            ) : null}
          </div>
          <LineItemsCard
            bare
            footer={
              <>
                <LineActionsBar>
                  {!hasPlan ? (
                    <CatalogAddModal
                      label="Add plan"
                      products={catalogProducts("plan")}
                      pricesFor={catalogPricesFor("plan")}
                      productById={productById}
                      onAdd={(priceId) => addCatalogPrice("plan", priceId)}
                      searchPlaceholder="Search plans…"
                    />
                  ) : (
                    <>
                      <CatalogAddModal
                        label="Add recurring addon"
                        products={catalogProducts("addon")}
                        pricesFor={catalogPricesFor("addon")}
                        productById={productById}
                        onAdd={(priceId) => addCatalogPrice("addon", priceId)}
                        effectiveAmountMinor={effectiveCatalogAmount}
                        searchPlaceholder="Search addons…"
                      />
                      <LineActionSeparator />
                      <CatalogAddModal
                        label="Add charge"
                        products={catalogProducts("charge")}
                        pricesFor={catalogPricesFor("charge")}
                        productById={productById}
                        onAdd={(priceId) => addCatalogPrice("charge", priceId)}
                        searchPlaceholder="Search charges…"
                      />
                    </>
                  )}
                  {recommendedAddons.length > 0 ? (
                    <span className="inline-flex min-w-0 flex-wrap gap-1.5 align-middle">
                      {recommendedAddons.map(({ product, price }) => (
                        <button
                          key={price.id}
                          type="button"
                          onClick={() => addLine("addon", price.id)}
                          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-xs font-normal wrap-anywhere text-foreground transition-colors hover:bg-accent"
                        >
                          <Plus className="size-3 shrink-0" /> {product.name}
                          <span className="text-xs text-muted-foreground uppercase">
                            Recommended
                          </span>
                        </button>
                      ))}
                    </span>
                  ) : null}
                </LineActionsBar>
                {/* Coupons + manual discount, the second bar. Two coupon entry
                    points: this used to be the free-text box alone, so an operator
                    had to know the code by heart. Both fill the same `coupon_code`
                    field. Hidden once one is applied — a second coupon would
                    silently replace the first. */}
                <LineActionsBar>
                  {/* The real posted field, whichever control filled it. */}
                  <input type="hidden" name="coupon_code" value={couponCode} />
                  {!couponCode && !showCouponCode ? (
                    <>
                      <CouponPickerModal
                        coupons={coupons}
                        currency={estCurrency}
                        label="Add coupon"
                        onSelect={(code) => {
                          setCouponCode(code);
                          setShowCouponCode(false);
                          setCouponDraft("");
                        }}
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
                  {!showManualDiscount ? (
                    <LineActionLink onClick={() => setShowManualDiscount(true)}>
                      Add manual discount
                    </LineActionLink>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-foreground">
                      <SelectField
                        name="md_type"
                        value={mdType}
                        // Switching the unit clears the number (the inputs are
                        // `key`ed for the same reason), so the mirror must clear
                        // with it or the rail would quote 25 CURRENCY as 25%.
                        onValueChange={(v) => {
                          setMdType(v);
                          setMdValue("");
                        }}
                        ariaLabel="Manual discount type"
                        className="w-44"
                        options={[
                          { value: "percent", label: "Percentage (%)" },
                          { value: "amount", label: "Fixed amount" },
                        ]}
                      />
                      {/* One `md_value` field, two units — a percent is a plain
                          integer, a fixed amount is money. The money branch posts
                          integer minor under the same name, in the plan's currency.
                          Keyed so switching type clears the number rather than
                          reinterpreting it. */}
                      {mdType === "amount" ? (
                        <MoneyInput
                          key="md-amount"
                          name="md_value"
                          currency={planPrice?.currency ?? ""}
                          className="w-40"
                          onMinorChange={(minor) => setMdValue(minor == null ? "" : String(minor))}
                        />
                      ) : (
                        <Input
                          key="md-percent"
                          name="md_value"
                          type="number"
                          min={1}
                          max={100}
                          placeholder="Value"
                          className="w-28 tabular-nums"
                          aria-label="Manual discount value"
                          onChange={(e) => setMdValue(e.target.value)}
                        />
                      )}
                      <SelectField
                        name="md_duration"
                        defaultValue="one_time"
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
                          setShowManualDiscount(false);
                          setMdValue("");
                        }}
                      >
                        Remove
                      </Button>
                      <InlineFieldError name="md_value" />
                    </div>
                  )}
                </LineActionsBar>
              </>
            }
          >
            {planRows.length > 0 ? (
              <>
                <LineGroupLabel>Plan</LineGroupLabel>
                {planRows.map(({ l, i }) => renderRow(l, i))}
              </>
            ) : (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Add a plan to start.
              </div>
            )}

            {addonRows.length > 0 ? (
              <>
                <LineGroupLabel>Add-ons</LineGroupLabel>
                {addonRows.map(({ l, i }) => renderRow(l, i))}
              </>
            ) : null}

            {chargeRows.length > 0 ? (
              <>
                <LineGroupLabel>One-time products</LineGroupLabel>
                {chargeRows.map(({ l, i }) => renderRow(l, i))}
              </>
            ) : null}

            {/* Coupons group — the applied coupon is listed among the line items
                with its duration ("Applicable for 2 months"). At most ONE
                row: `createSubBody` carries a single `coupon_code`. The discount
                figure is the coupon's own; it is deliberately NOT summed into the
                Amount column, because `estimateNewSubscriptionAction` sends no
                coupon and so the rail on the right prices the FULL list price —
                stating a discounted total the preview does not contain would be
                the same class of lie the estimate work just removed. */}
            {couponCode ? (
              <>
                <LineGroupLabel>Coupons</LineGroupLabel>
                <LineRow
                  name={appliedCoupon?.name || couponCode}
                  subtitle={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono wrap-anywhere">{couponCode}</span>
                      <span>
                        ·{" "}
                        {appliedCoupon
                          ? couponDurationLabel(appliedCoupon)
                          : "We validate it when you create the subscription"}
                      </span>
                      <span>· Not included in the preview</span>
                    </span>
                  }
                  currency={estCurrency}
                  qtyBased={false}
                  amountText={appliedCoupon ? couponDiscountLabel(appliedCoupon, estCurrency) : "—"}
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
          {!hasPlan && validLines.length > 0 ? (
            <p className="border-t px-5 py-3 text-sm text-destructive">
              Add at least one plan line. A subscription needs a recurring plan.
            </p>
          ) : null}
        </RecordCard>

        <FormCard title="Billing">
          {/* Subscription ID — the same `Field` the change form renders, where it is
              read-only. One control, editable before the subscription exists and fixed
              after. */}
          <Field
            name="subscription_id"
            label="Subscription ID"
            help="If you do not enter an ID, we generate one automatically."
          >
            <Input
              name="subscription_id"
              placeholder="ID used to uniquely identify the subscription"
              maxLength={50}
            />
          </Field>
          <Field name="po_number" label="PO number" help="Enter the Purchase Order Number.">
            <Input name="po_number" maxLength={100} />
          </Field>

          <Wide>
            <FieldBlock
              name="start_date"
              label="Start date"
              help="Use this mainly for future subscriptions. In some cases, you can enter a past date."
            >
              {/* Guarded choice cards, not a raw RadioGroup: a failed create must keep
                  "specific". */}
              <ChoiceCardsField
                value={startMode}
                onValueChange={(v) => setStartMode(v as "immediately" | "specific")}
                ariaLabel="Start date"
                options={[
                  { value: "immediately", label: "Immediately", hint: "Starts today" },
                  { value: "specific", label: "On a specific date", hint: "Select the start" },
                ]}
              />
              {startMode === "specific" ? (
                <DateTimeField
                  name="start_date"
                  defaultValue={startDate}
                  onUtcChange={setStartDate}
                />
              ) : null}
            </FieldBlock>
          </Wide>

          <Wide>
            <FieldBlock
              name="billing_cycles_count"
              label="Billing cycles"
              help="The number of billing cycles to charge this subscription. This value overrides the billing cycles set on the plan."
            >
              <ChoiceCardsField
                value={cyclesMode}
                onValueChange={(v) => setCyclesMode(v as "forever" | "fixed")}
                ariaLabel="Billing cycles"
                options={[
                  { value: "forever", label: "Forever", hint: "Renews until cancelled" },
                  {
                    value: "fixed",
                    label: "Fixed number of cycles",
                    hint: "Charged for a set number of cycles",
                  },
                ]}
              />
              {cyclesMode === "fixed" ? (
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={cyclesCount}
                  onChange={(e) => setCyclesCount(e.target.value)}
                  className="w-32 tabular-nums"
                  aria-label="Number of billing cycles"
                />
              ) : null}
            </FieldBlock>
          </Wide>

          {/* Three-way, exactly like the engine: blank inherits the plan's configured
              trial, 0 disables it, N overrides it. The help text states the inherited
              value rather than leaving it implicit. */}
          <Field
            name="trial_days"
            label="Trial days"
            help={
              planTrialCount > 0
                ? `This plan gives a ${intervalAdj(planTrialCount, planTrialUnit)} trial. Leave blank to keep it. Enter 0 for no trial, or enter a number of days to override it.`
                : "Days before the first charge. To charge immediately, leave blank or enter 0."
            }
          >
            <Input
              name="trial_days"
              type="number"
              min={0}
              step={1}
              placeholder={
                planTrialCount > 0
                  ? `${intervalLabel(planTrialCount, planTrialUnit)} (from plan)`
                  : "0"
              }
              className="tabular-nums"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
          <Field
            name="net_term_days"
            label="Net term days"
            help="Payment due N days after the invoice date."
          >
            <Input
              name="net_term_days"
              type="number"
              min={0}
              max={365}
              step={1}
              placeholder="0"
              className="tabular-nums"
            />
          </Field>

          <Wide>
            {/* The inherit option names the RESOLVED value — the point of inheriting is
                seeing what you inherit. `createSubscription` defaults an omitted field to
                the customer's. */}
            <Field
              name="auto_collection"
              label="Auto-collection"
              help={
                <>
                  Auto-collection tries to charge the customer&apos;s payment method automatically
                  each time we create an invoice.
                  {autoCollection === "" ? (
                    <>
                      {" "}
                      {inheritedAutoCollection
                        ? inheritedAutoCollection === "on"
                          ? `${selectedCustomer!.label} uses auto-collection, so we charge invoices on this subscription to their payment method automatically.`
                          : `${selectedCustomer!.label} uses manual collection, so we send invoices on this subscription instead of charging them.`
                        : "Select a customer to see which setting this inherits."}
                    </>
                  ) : null}
                </>
              }
            >
              <SelectField
                name="auto_collection"
                value={autoCollection}
                onValueChange={setAutoCollection}
                ariaLabel="Auto-collection"
                className="sm:max-w-sm"
                options={[
                  {
                    value: "",
                    label: inheritedAutoCollection
                      ? `Use customer's setting (currently ${inheritedAutoCollection === "on" ? "On" : "Off"})`
                      : "Use customer's setting",
                  },
                  { value: "on", label: "On: charge the card automatically" },
                  { value: "off", label: "Off: send the invoice" },
                ]}
              />
            </Field>
          </Wide>
        </FormCard>

        <FormCard title="Invoicing" columns={1}>
          {/*
            The signup control, with a real field behind it: `invoice_immediately`
            on the create route. `true` raises (and, with auto-collection on, collects)
            the first invoice now; `false` queues the first period as a pending unbilled
            charge that rides on the next invoice. Preselected `true` because that is what
            the ENGINE does when the field is omitted — deliberately NOT read from
            `businesses.default_invoice_immediately`, which governs change/term-change
            proration, not signup. Only meaningful when a first invoice would be raised at
            all, so it is hidden for a trial or a future-dated start rather than shown inert.
          */}
          {chargesLater ? null : (
            <FieldBlock
              name="invoice_immediately"
              label="How should the first invoice be raised?"
              help="Applies only to this signup's first invoice, not to renewals."
            >
              <ChoiceCardsField
                name="invoice_immediately"
                ariaLabel="How the first invoice is raised"
                value={invoiceNow ? "true" : "false"}
                onValueChange={(v) => setInvoiceNow(v === "true")}
                options={[
                  {
                    value: "true",
                    label: "Immediately",
                    hint: "Raise the first invoice now. If auto-collection is on, we collect it.",
                  },
                  {
                    value: "false",
                    label: "Later: add the charges to unbilled charges",
                    hint: "We do not invoice or collect anything now. The charges are added to the next invoice.",
                  },
                ]}
              />
            </FieldBlock>
          )}
          {/* Only when Create takes a charge: otherwise there is no payment to fail. */}
          {chargesOnCreate ? (
            <FieldBlock
              name="on_charge_failure"
              label="If the payment fails"
              help="Applies to this signup's first payment only."
            >
              <RadioField
                name="on_charge_failure"
                ariaLabel="If the payment fails"
                value={chargeFailure}
                onValueChange={(v) => setChargeFailure(v as typeof chargeFailure)}
                options={[
                  {
                    value: "refuse",
                    label: "Do not create the subscription",
                    hint: "We charge first. If the payment fails, we create nothing.",
                  },
                  {
                    value: "dun",
                    label: "Create it, and dunning collects the invoice",
                    hint: "The subscription becomes active. The invoice stays open, and dunning tries again, as after a failed renewal.",
                  },
                ]}
              />
            </FieldBlock>
          ) : null}
          {/*
            This is `create_pending_invoices`, which governs RENEWALS: each renewal either
            posts a normal invoice, or opens a `pending` invoice that accretes charges
            until it is closed (see src/modules/invoicing/pending.ts). Both values are
            explicit, and the business's real default is preselected rather than offered
            as a vague "same as business" choice. The SIGNUP control is the separate
            `invoice_immediately` above — do not relabel this field to mean that.
          */}
          <FieldBlock
            name="create_pending_invoices"
            label="How should renewals be invoiced?"
            help="Applies to every renewal of this subscription. Defaults to this business's setting."
          >
            <ChoiceCardsField
              name="create_pending_invoices"
              ariaLabel="How renewals are invoiced"
              value={pendingInvoices}
              onValueChange={setPendingInvoices}
              options={[
                { value: "false", label: "Post an invoice on each renewal" },
                {
                  value: "true",
                  label: "Keep a pending invoice",
                  hint: "Charges accumulate on it until it is closed.",
                },
              ]}
            />
          </FieldBlock>
          {planPrice?.type === "recurring" ? (
            <TermBillingFields
              key={planPrice.id}
              price={planPrice}
              pending={pendingInvoices === "true"}
            />
          ) : null}
          <Field name="invoice_notes" label="Invoice notes">
            <Input name="invoice_notes" maxLength={2000} />
          </Field>
        </FormCard>

        {/*
          NO SHIPPING ADDRESS SECTION — deliberately omitted, do not re-add without the backend.
          There used to be one here (a "Same as billing address" toggle plus Country /
          First+Last Name / Email / Company / Phone / Address line 1+2 / City / State / Postal
          code) — all 12 controls rendered and every one of them posting into the void:
          `ship_*` appears in neither `createSubSchema` nor `createSubBody`, and there is no
          subscription-level shipping column at all. Shipping addresses DO exist in our model,
          just not here — on the CUSTOMER (`customers.shipping_address`, edited via the shared
          `<AddressFields prefix="ship_">`) and snapshotted onto the INVOICE
          (`invoices.shipping_address`). To build this properly, add the subscription-level
          column + body field first, then render `AddressFields`.
        */}
      </SubFormFrame>
    </ActionForm>
  );
}

/**
 * Monthly usage billing and the minimum commitment, preselected from the plan price
 * (re-seeded when the plan changes, via `key`). Both are refused with pending invoices,
 * so that choice posts them off.
 */
function TermBillingFields({ price, pending }: { price: Price; pending: boolean }) {
  const allowsMonthly =
    (price.interval === "month" && (price.interval_count ?? 1) >= 2) || price.interval === "year";
  const [monthly, setMonthly] = useDefaultState(price.bill_usage_monthly ?? false);
  const [commitment, setCommitment] = useDefaultState(
    price.commitment_amount_minor != null
      ? toMajorInput(price.commitment_amount_minor, price.currency)
      : "",
  );
  if (pending)
    return (
      <>
        <input type="hidden" name="bill_usage_monthly" value="false" />
        <input type="hidden" name="commitment_present" value="1" />
      </>
    );
  return (
    <>
      <input
        type="hidden"
        name="bill_usage_monthly"
        value={allowsMonthly && monthly ? "true" : "false"}
      />
      {allowsMonthly ? (
        <Wide>
          <SwitchRow
            label="Bill usage every month"
            hint="We invoice metered usage at the end of each month. The plan fee stays on the billing period."
            checked={monthly}
            onCheckedChange={setMonthly}
          />
        </Wide>
      ) : null}
      <input type="hidden" name="commitment_present" value="1" />
      <input
        type="hidden"
        name="commitment_amount_minor"
        value={majorToMinor(commitment, price.currency)}
      />
      <Field
        name="commitment_amount_minor"
        label="Minimum commitment per billing period"
        help="At the end of each billing period, we bill the difference if the fees are less. Leave empty for no commitment."
      >
        <MoneyField currency={price.currency} value={commitment} onChange={setCommitment} />
      </Field>
    </>
  );
}
