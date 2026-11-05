"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import { currencyExponent, majorStep } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The subscription LINE-ITEM TABLE, shared by "Create a subscription" and
 * "Change a subscription".
 *
 * The two screens had drifted into two different tables for the same thing: create
 * drew a filled grey column band, 5rem/9rem fixed tracks, `divide-y`, an always-open
 * price dropdown per row and a text "Remove" button; change drew a hairline head,
 * proportional tracks, per-row rules, a bold item name with a ⋮ menu, and an editable
 * Amount for flat lines. There is ONE table on both pages now — this module owns the
 * chrome (grid, heads, group labels, row, money inputs, the action bars) and each
 * form supplies only its own row content and actions.
 *
 * Anything visual added here lands on both screens; that is the point. Do not
 * re-style a row locally.
 */

/**
 * Proportional tracks with hard minimums (~600px). The table switches on the CARD's
 * width (container query), not the viewport's: the same card sits in a wide column
 * on desktop and full-bleed on a phone. Narrower than `@2xl`, a row stacks — name,
 * amount and actions on top, the editable inputs underneath.
 */
export const LINE_GRID =
  "grid grid-cols-[minmax(160px,1.6fr)_minmax(8rem,1fr)_minmax(4.5rem,0.6fr)_minmax(8.5rem,1fr)_2rem] items-center gap-4";

const ROW_GRID = cn(
  "grid grid-cols-[minmax(0,1fr)_auto_2rem] items-center gap-x-3",
  "[grid-template-areas:'name_amount_actions'_'unit_qty_qty']",
  "@2xl:grid-cols-[minmax(160px,1.6fr)_minmax(8rem,1fr)_minmax(4.5rem,0.6fr)_minmax(8.5rem,1fr)_2rem] @2xl:gap-x-4",
  "@2xl:[grid-template-areas:'name_unit_qty_amount_actions']",
);

/** Inside a titled card the table runs edge to edge and takes the card's gutter. */
const BareContext = React.createContext(false);

/** Cadence as an adverb, for the muted second line of a row ("yearly addon"). */
export const INTERVAL_LABEL: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

/**
 * The muted line under an item name. The currency is deliberately NOT repeated per
 * row: every line on a subscription shares one currency (the engine refuses
 * otherwise), so the table heading states it once.
 */
export function lineSubtitle(interval: string | null | undefined, slot: string): string {
  return interval ? `${INTERVAL_LABEL[interval] ?? interval} ${slot}` : slot;
}

/** Group heading: quiet metadata that separates rows, not a band competing with them. */
export function LineGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-5 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

/**
 * Card shell + column heads. The heads are a hairline, not a filled band: the group
 * labels and row rules are already horizontal lines, and a shaded band on top made
 * the table read as stripes rather than rows.
 */
export function LineItemsCard({
  children,
  footer,
  className,
  bare = false,
}: {
  children: React.ReactNode;
  /** One or more <LineActionsBar> elements. */
  footer?: React.ReactNode;
  className?: string;
  /** No border of its own — for a table that sits inside a titled card. */
  bare?: boolean;
}) {
  return (
    <BareContext.Provider value={bare}>
      <div
        className={cn(
          "@container min-w-0",
          !bare && "rounded-xl border border-border bg-card",
          className,
        )}
      >
        <div
          className={cn(
            LINE_GRID,
            "hidden border-b py-2.5 text-xs font-medium tracking-wider text-muted-foreground uppercase @2xl:grid",
            bare ? "border-t px-5" : "px-4",
          )}
        >
          <span>Items</span>
          <span>Price per unit</span>
          <span className="text-center">Quantity</span>
          <span className="text-right">Amount</span>
          <span />
        </div>
        {/* No `divide-y`: each row draws its own bottom hairline, so the wrapper would
          double every rule AND draw one under each group label. */}
        <div className={cn(bare ? "border-t px-5 @2xl:border-t-0" : "px-4")}>{children}</div>
        {footer}
      </div>
    </BareContext.Provider>
  );
}

/** Footer bar of "+ Add …" links. Two are stacked: items, then coupons/discount. */
export function LineActionsBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const bare = React.useContext(BareContext);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/10 py-3 text-sm font-medium text-primary",
        bare ? "px-5" : "px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The `|` (or an "OR") between two links in a LineActionsBar. */
export function LineActionSeparator({ label }: { label?: string }) {
  return (
    <span className={cn("font-normal", label ? "text-xs text-muted-foreground" : "text-border")}>
      {label ?? "|"}
    </span>
  );
}

/** A "+ Add something" link inside a LineActionsBar. */
export function LineActionLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 transition-colors hover:text-primary/80"
    >
      <Plus className="size-4" /> {children}
    </button>
  );
}

/**
 * A major-unit string, fixed to the currency's own decimal places — `27918` becomes
 * `27918.00`, and a JPY `1000` stays `1000` (exponent 0). Money inputs must carry the
 * decimals; these showed bare integers, so the same column mixed `27918` with the
 * computed `₹7,520.00`.
 *
 * Not `toMajorInput` from lib/money: that one takes MINOR units, and every caller
 * here already holds the major-unit string the field edits.
 */
function padMajor(value: string, currency: string): string {
  if (value.trim() === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(currencyExponent(currency)) : value;
}

/** `INR 752.00` — the read-only twin of `LineMoneyInput`, same geometry, no control. */
function LineMoneyStatic({
  currency,
  value,
  className,
}: {
  currency: string;
  value: string;
  className?: string;
}) {
  return (
    // Same geometry as the input it replaces — currency pinned left, digits right —
    // so a row does not jump sideways when it is staged for removal.
    <span
      className={cn(
        "flex items-baseline justify-between gap-1.5 px-3 text-sm tabular-nums",
        className,
      )}
    >
      <span className="text-xs font-semibold text-muted-foreground uppercase">{currency}</span>
      {padMajor(value, currency) || "—"}
    </span>
  );
}

/**
 * Money field inside a line row: currency code pinned inside the control, digits
 * right-aligned and tabular. Built on the `Input` primitive rather than a hand-rolled
 * bordered div, so focus rings, disabled styling and the dark theme come from the
 * design system (the change form used to hand-roll this and set `font-mono`).
 *
 * ── WHY THE DISPLAYED VALUE IS NOT THE PROP ─────────────────────────────────────
 * The field must SHOW two decimals (`27918.00`) without reformatting mid-typing: pad
 * on every keystroke and `27918.` collapses to `27918.00` before the operator can type
 * the cents, and the caret jumps. So while the field has focus its own draft stands
 * verbatim; on blur the draft is dropped and the padded prop is shown again. `onChange`
 * still fires on every keystroke, so the payload sees each edit as it happens — only
 * the DISPLAY is deferred.
 *
 * `step` comes from the currency too: `0.01` for INR/USD, `1` for JPY. A hardcoded
 * 0.01 let an operator type an amount finer than the currency can represent, which
 * `toMinor` then rounded away from what they typed.
 */
export function LineMoneyInput({
  currency,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  currency: string;
  /** MAJOR units, as a string — the caller owns the minor-unit conversion. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  /** The operator's in-progress text, or null when the field is not being edited. */
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <div className="relative w-full min-w-0">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-xs font-semibold text-muted-foreground uppercase">
        {currency}
      </span>
      <Input
        type="number"
        min={0}
        step={majorStep(currency)}
        value={draft ?? padMajor(value, currency)}
        disabled={disabled}
        // Seed the draft with what is already on screen, so focusing the field does
        // not shift the digits under the cursor.
        onFocus={() => setDraft(padMajor(value, currency))}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        className="pl-12 text-right tabular-nums"
        aria-label={ariaLabel}
      />
    </div>
  );
}

/**
 * One line row.
 *
 * Column rules, applied identically on both screens:
 *  - a QUANTITY-BASED price (per_unit/tiered) edits `Price per unit` × `Quantity`
 *    and derives the Amount;
 *  - a quantity-INVARIANT one (flat) has no meaningful unit×qty split, so both are
 *    dashed and the AMOUNT itself is the editable field.
 *
 * ── PENDING REMOVAL (`removing`) ────────────────────────────────────────────────
 * A line staged for removal used to render at `opacity 0.5` with every control
 * DISABLED, which read as "this row is unavailable", not "this row is going away" —
 * and greyed-out numbers read as empty placeholders. Measured 2026-08-24: the row
 * said `₹0.00/month` while the estimate rail beside it credited ₹7,520.00, so the
 * two disagreed with nothing on screen reconciling them.
 *
 * So `removing` is a STATED outcome instead of a disabled state: full-contrast
 * digits (the line's own snapshot values, which is what the credit is computed
 * from), a struck-through name, a "Removing" chip, and the Restore action in the
 * row rather than only inside the kebab. The values go STATIC rather than disabled
 * because editing a removed line changes nothing — the payload sends only its id.
 */
export function LineRow({
  /** Bold item name — shown when no `picker` is supplied. */
  name,
  /** Muted second line, e.g. "yearly addon". */
  subtitle,
  /** Chips rendered after the subtitle (mandatory / not applicable / coupon meta). */
  badges,
  /** Replaces name+subtitle with a control (the price picker) while it is open. */
  picker,
  currency,
  qtyBased,
  quantity,
  onQuantityChange,
  /** MAJOR-unit string for the price/amount input. */
  unitValue,
  onUnitChange,
  unitDisabled,
  amountMinor,
  amountText,
  amountEditable,
  actions,
  dimmed,
  removing,
  restoreAction,
}: {
  name?: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  picker?: React.ReactNode;
  currency: string;
  qtyBased: boolean;
  quantity?: number;
  onQuantityChange?: (quantity: number) => void;
  unitValue?: string;
  onUnitChange?: (value: string) => void;
  unitDisabled?: boolean;
  amountMinor?: number | null;
  /** Replaces the formatted `amountMinor` — a coupon states its own discount ("10%"). */
  amountText?: React.ReactNode;
  amountEditable?: boolean;
  actions?: React.ReactNode;
  dimmed?: boolean;
  /** Staged for removal on apply — see the note above. */
  removing?: boolean;
  /**
   * The undo for `removing`, rendered beside the "Removing on apply" chip rather than
   * in the actions cell. That cell is a 2rem track sized for a 32px icon button (see
   * LINE_GRID), so a text button placed there overflows LEFTWARDS and paints over the
   * Amount — measured: `₹7,520.0Restore`. Next to the chip it also reads better: the
   * chip states the outcome and the undo sits with it.
   */
  restoreAction?: React.ReactNode;
}) {
  const bare = React.useContext(BareContext);
  // A flat line edits its AMOUNT. Wide, that input sits in the Amount column; stacked,
  // the top row shows the figure and the input drops to the second row.
  const editAmount = Boolean(amountEditable && onUnitChange && !removing);
  const amountFigure = (
    <span className="text-base font-medium whitespace-nowrap tabular-nums">
      {amountText ?? (amountMinor != null ? money(amountMinor, currency) : "—")}
    </span>
  );
  const dash = <span className="block text-center text-sm text-muted-foreground">—</span>;
  const stackedLabel = (text: string) => (
    <span className="shrink-0 text-xs text-muted-foreground @2xl:hidden">{text}</span>
  );
  return (
    <div
      className={cn(
        "border-b border-border/40 py-4 last:border-0",
        // `dimmed` is still honoured for anything that is genuinely inert; a pending
        // removal is NOT that (see the note above) and gets a soft destructive band
        // instead, so the row reads as "going away" at full contrast.
        dimmed && !removing && "opacity-50",
        removing &&
          cn("border-b-destructive/20 bg-destructive-soft/60", bare ? "-mx-5 px-5" : "-mx-4 px-4"),
      )}
    >
      <div className={ROW_GRID}>
        <div className="min-w-0 pr-2 [grid-area:name]">
          {picker ?? (
            <div className="min-w-0">
              {/* Wrapped, never truncated: the item cell is static text — a name on two
                  lines plus a cadence subtitle — and `truncate` here is what clipped
                  `platform-pro-v202607 · INR ₹279,180.00/` mid-value. */}
              <div
                className={cn(
                  "text-sm font-bold wrap-anywhere text-foreground",
                  removing && "line-through decoration-destructive/70",
                )}
              >
                {name}
              </div>
              {subtitle ? (
                <div className="mt-0.5 text-xs wrap-anywhere text-muted-foreground">{subtitle}</div>
              ) : null}
            </div>
          )}
          {removing || badges ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {removing ? (
                <span className="rounded-md bg-destructive-soft px-1.5 py-0.5 text-xs font-semibold text-destructive">
                  Removing on apply
                </span>
              ) : null}
              {removing ? restoreAction : null}
              {badges}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 [grid-area:unit]">
          {qtyBased && onUnitChange ? (
            <div className="mt-2 flex items-center gap-2 @2xl:mt-0">
              {stackedLabel("Per unit")}
              {removing ? (
                <LineMoneyStatic currency={currency} value={unitValue ?? ""} className="w-full" />
              ) : (
                <LineMoneyInput
                  currency={currency}
                  value={unitValue ?? ""}
                  onChange={onUnitChange}
                  disabled={unitDisabled}
                  ariaLabel="Price per unit"
                />
              )}
            </div>
          ) : editAmount ? (
            <>
              <div className="mt-2 flex items-center gap-2 @2xl:hidden">
                {stackedLabel("Amount")}
                <LineMoneyInput
                  currency={currency}
                  value={unitValue ?? ""}
                  onChange={onUnitChange!}
                  disabled={unitDisabled}
                  ariaLabel="Amount"
                />
              </div>
              <div className="hidden @2xl:block">{dash}</div>
            </>
          ) : (
            <div className="hidden @2xl:block">{dash}</div>
          )}
        </div>

        <div className="min-w-0 text-center [grid-area:qty]">
          {qtyBased && onQuantityChange ? (
            <div className="mt-2 flex items-center justify-end gap-2 @2xl:mt-0">
              {stackedLabel("Qty")}
              {removing ? (
                <span className="w-full text-sm tabular-nums">{quantity ?? 1}</span>
              ) : (
                <Input
                  type="number"
                  min={1}
                  value={quantity ?? 1}
                  disabled={unitDisabled}
                  onChange={(e) => onQuantityChange(Number(e.target.value) || 1)}
                  // Fixed while stacked: an auto track sized to the input would starve the name.
                  className="w-20 min-w-0 text-center tabular-nums @2xl:w-full"
                  aria-label="Quantity"
                />
              )}
            </div>
          ) : (
            <div className="hidden @2xl:block">{dash}</div>
          )}
        </div>

        <div className="min-w-0 text-right [grid-area:amount]">
          {editAmount ? (
            <>
              <div className="hidden @2xl:block">
                <LineMoneyInput
                  currency={currency}
                  value={unitValue ?? ""}
                  onChange={onUnitChange!}
                  disabled={unitDisabled}
                  ariaLabel="Amount"
                />
              </div>
              <div className="@2xl:hidden">{amountFigure}</div>
            </>
          ) : (
            amountFigure
          )}
        </div>

        <div className="flex items-center justify-end gap-1 text-right [grid-area:actions]">
          {actions}
        </div>
      </div>
    </div>
  );
}
