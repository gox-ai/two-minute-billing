"use client";

import * as React from "react";
import Link from "next/link";
import type {
  AddressFieldLocks,
  CheckoutFieldKey,
  CheckoutFieldState,
  PortalFieldKey,
  PortalFieldState,
} from "@/lib/api";
import { useDefaultState } from "@/lib/use-default-state";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { NAME_KEY, keptVisibleBy, lockedBy, portalInputName } from "./field-matrix";

const STATE_LABEL: Record<PortalFieldState, string> = {
  mandatory: "Required",
  show: "Optional",
  hide: "Hidden",
  read_only: "Read-only",
};

const options = (states: readonly PortalFieldState[]) =>
  states.map((v) => ({ value: v, label: STATE_LABEL[v] }));
const CHECKOUT_OPTIONS = options(["mandatory", "show", "hide"]);
const CHECKOUT_NO_HIDDEN = options(["mandatory", "show"]);
/** The checkout's name: asked (and required) or not asked at all. */
const CHECKOUT_NAME = options(["mandatory", "hide"]);
const CHECKOUT_NAME_KEPT = options(["mandatory"]);
const PORTAL_OPTIONS = options(["mandatory", "show", "hide", "read_only"]);
const PORTAL_EDITABLE = options(["mandatory", "show"]);

/** A key both matrices carry; checkout-only rows (email, PO number) are built separately. */
type Row = { key: CheckoutFieldKey & PortalFieldKey; label: string; help?: React.ReactNode };

const WHERE_USED = "Applies only where the buyer's country uses one.";

const CUSTOMER: Row[] = [
  {
    key: "customer.first_name",
    label: "First name",
    help: "The name on the invoice. Hidden: we do not ask for a name, and invoices show the email address.",
  },
  { key: "customer.last_name", label: "Last name" },
  { key: "customer.phone", label: "Phone number" },
  { key: "customer.company", label: "Company name" },
  {
    key: "customer.tax_registration_number",
    label: "Tax registration number",
    help: "GSTIN, VAT or tax ID.",
  },
];

const BILLING: Row[] = [
  { key: "billing.line1", label: "Address line 1" },
  { key: "billing.line2", label: "Address line 2" },
  { key: "billing.line3", label: "Address line 3" },
  { key: "billing.city", label: "City" },
  { key: "billing.state", label: "State / province (printed name)", help: WHERE_USED },
  { key: "billing.state_code", label: "State / province code", help: WHERE_USED },
  {
    key: "billing.postal_code",
    label: "Postal / ZIP code",
    help: `${WHERE_USED} City and state fill in from the postal code.`,
  },
  {
    key: "billing.country",
    label: "Country",
    help: "It sets the state list and the postal code format. Hidden: we also do not ask for the postal code, city or state.",
  },
];

/**
 * Column heads over the two selects; each select also carries its own aria-label. The
 * selects stay boxed (a matrix needs aligned columns) at 120px and the default 36px height.
 */
function SurfaceHeads() {
  return (
    <div
      aria-hidden
      className="hidden justify-end gap-2 px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground sm:flex"
    >
      <span className="w-30">Checkout</span>
      <span className="w-30">Portal</span>
    </div>
  );
}

/** One select with a caption that shows only when the heads are hidden (narrow screens). */
function SurfaceSelect({
  caption,
  name,
  ariaLabel,
  value,
  onValueChange,
  options: opts,
  disabled,
}: {
  caption: string;
  name: string;
  ariaLabel: string;
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground sm:hidden">{caption}</span>
      <SelectField
        name={name}
        value={value}
        onValueChange={onValueChange}
        ariaLabel={ariaLabel}
        options={opts}
        disabled={disabled}
        className="w-30"
      />
    </div>
  );
}

/** Lines 2 and 3 on a surface where line 1 is hidden: shown as Hidden, own value still saved. */
function FollowsLine1({ caption, name, value }: { caption: string; name: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground sm:hidden">{caption}</span>
      <input type="hidden" name={name} value={value} />
      <span className="flex h-9 w-30 items-center text-sm text-muted-foreground">Hidden</span>
    </div>
  );
}

const FOLLOWS_LINE1 = new Set<string>(["billing.line2", "billing.line3"]);

/**
 * One field's two pickers. A locked field renders both disabled at Required; a disabled
 * `SelectField` still posts its value, so the save carries the lock too.
 */
function FieldStateRow({
  row,
  checkout,
  portal,
  locks,
  consequence,
  onChange,
  line1Hidden,
}: {
  row: Row;
  checkout: CheckoutFieldState;
  portal: PortalFieldState;
  locks: AddressFieldLocks | null;
  consequence?: (c: CheckoutFieldState, p: PortalFieldState) => React.ReactNode;
  /** Reports this row's live values (line 1 only: lines 2 and 3 follow it). */
  onChange?: (surface: "checkout" | "portal", v: string) => void;
  line1Hidden?: { checkout: boolean; portal: boolean };
}) {
  const lock = lockedBy(locks, row.key);
  const keptVisible = keptVisibleBy(locks, row.key);
  const isName = row.key === NAME_KEY;
  const checkoutOptions = isName
    ? keptVisible
      ? CHECKOUT_NAME_KEPT
      : CHECKOUT_NAME
    : keptVisible
      ? CHECKOUT_NO_HIDDEN
      : CHECKOUT_OPTIONS;
  const [c, setC] = useDefaultState<string>(lock ? "mandatory" : checkout);
  const [p, setP] = useDefaultState<string>(lock ? "mandatory" : portal);
  const followC = FOLLOWS_LINE1.has(row.key) && line1Hidden?.checkout === true;
  const followP = FOLLOWS_LINE1.has(row.key) && line1Hidden?.portal === true;
  return (
    <SettingRow
      label={row.label}
      htmlFor={row.key}
      help={row.help}
      placement="end"
      control={
        <div className="flex flex-col gap-2 sm:flex-row">
          {followC ? (
            <FollowsLine1 caption="Checkout" name={row.key} value={c} />
          ) : (
            <SurfaceSelect
              caption="Checkout"
              name={row.key}
              ariaLabel={`${row.label} at checkout`}
              value={c}
              onValueChange={(v) => {
                setC(v);
                onChange?.("checkout", v);
              }}
              options={checkoutOptions}
              disabled={lock != null}
            />
          )}
          {followP ? (
            <FollowsLine1 caption="Portal" name={portalInputName(row.key)} value={p} />
          ) : (
            <SurfaceSelect
              caption="Portal"
              name={portalInputName(row.key)}
              ariaLabel={`${row.label} in the portal`}
              value={p}
              onValueChange={(v) => {
                setP(v);
                onChange?.("portal", v);
              }}
              options={keptVisible ? PORTAL_EDITABLE : PORTAL_OPTIONS}
              disabled={lock != null}
            />
          )}
        </div>
      }
      consequence={
        lock ??
        keptVisible ??
        (followC || followP
          ? "Address line 1 is hidden, so this line is hidden too."
          : undefined) ??
        consequence?.(c as CheckoutFieldState, p as PortalFieldState) ??
        undefined
      }
    />
  );
}

/** PO number is checkout-only, and its presence is the Hosted pages switch. */
function PoNumberRow({
  defaultValue,
  collectsPoNumber,
  hostedPagesHref,
}: {
  defaultValue: CheckoutFieldState;
  collectsPoNumber: boolean;
  hostedPagesHref: string;
}) {
  const [v, setV] = useDefaultState<string>(defaultValue === "hide" ? "show" : defaultValue);
  return (
    <SettingRow
      label="PO number"
      htmlFor="invoice.po_number"
      placement="end"
      // Checkout only: a PO number belongs to the subscription, and the portal edits the
      // customer, so the Portal column has nothing to set.
      control={
        <div className="flex flex-col gap-2 text-sm sm:flex-row">
          <SurfaceSelect
            caption="Checkout"
            name="invoice.po_number"
            ariaLabel="PO number at checkout"
            value={v}
            onValueChange={setV}
            options={CHECKOUT_NO_HIDDEN}
          />
          <span className="w-30 self-center text-muted-foreground">Not asked</span>
        </div>
      }
      consequence={
        !collectsPoNumber ? (
          <>
            PO number collection is disabled in the{" "}
            <Link href={hostedPagesHref} className="text-primary hover:underline">
              checkout settings
            </Link>
            , so we do not apply this setting. Enable it there first.
          </>
        ) : v === "mandatory" ? (
          "The hosted checkout asks for a PO number and does not complete without one."
        ) : (
          "The hosted checkout asks for a PO number. Buyers may leave it blank."
        )
      }
    />
  );
}

/** Shipping is one checkout switch for the whole section; the portal edits the address book. */
function ShippingRow({ defaultValue }: { defaultValue: CheckoutFieldState }) {
  const [v, setV] = useDefaultState<string>(defaultValue);
  return (
    <SettingRow
      label="Shipping address"
      htmlFor="shipping.address"
      placement="end"
      help="We calculate tax from the billing address, not from the shipping address."
      control={
        <SurfaceSelect
          caption="Checkout"
          name="shipping.address"
          ariaLabel="Shipping address at checkout"
          value={v}
          onValueChange={setV}
          options={CHECKOUT_OPTIONS}
        />
      }
      consequence={
        v === "hide"
          ? "The hosted checkout does not ask for a shipping address."
          : v === "mandatory"
            ? "The hosted checkout does not continue without a shipping address. The new subscription ships to it."
            : "The buyer can add a shipping address at checkout. The new subscription ships to it."
      }
    />
  );
}

/**
 * The cards of the two field matrices. Every row posts under its own names, so the action
 * stores both matrices in one save.
 */
export function CheckoutFieldsCards({
  checkout,
  portal,
  locks,
  collectsPoNumber,
  hostedPagesHref,
}: {
  checkout: Record<CheckoutFieldKey, CheckoutFieldState>;
  portal: Record<PortalFieldKey, PortalFieldState>;
  locks: AddressFieldLocks | null;
  collectsPoNumber: boolean;
  hostedPagesHref: string;
}) {
  // Lines 2 and 3 follow line 1's live value on each surface.
  const [line1C, setLine1C] = useDefaultState<string>(checkout["billing.line1"]);
  const [line1P, setLine1P] = useDefaultState<string>(portal["billing.line1"]);
  const line1Hidden = { checkout: line1C === "hide", portal: line1P === "hide" };
  const row = (
    r: Row,
    consequence?: (c: CheckoutFieldState, p: PortalFieldState) => React.ReactNode,
  ) => (
    <FieldStateRow
      key={r.key}
      row={r}
      checkout={checkout[r.key]}
      portal={portal[r.key]}
      locks={locks}
      consequence={consequence}
      line1Hidden={line1Hidden}
      onChange={
        r.key === "billing.line1"
          ? (surface, v) => (surface === "checkout" ? setLine1C(v) : setLine1P(v))
          : undefined
      }
    />
  );
  return (
    <>
      <SettingsCard title="Customer" meta="Who is buying">
        <SurfaceHeads />
        {/* The email rule is structural: a new subscription needs one, a change keeps the
            customer's own. The matrix value is never read, so there is no picker — the stored
            value posts back unchanged. The portal form does not ask for an email. */}
        <input type="hidden" name="customer.email" value={checkout["customer.email"]} />
        <SettingRow
          label="Email"
          placement="end"
          control={
            <div className="flex flex-col gap-2 text-sm sm:flex-row">
              <span className="w-30 font-medium">Always required</span>
              <span className="w-30 text-muted-foreground">Not asked</span>
            </div>
          }
          help="A new subscription cannot start without one. A plan-change checkout keeps the customer's email and does not ask."
        />
        {CUSTOMER.map((r) =>
          row(
            r,
            r.key === "customer.phone"
              ? (c, p) =>
                  c === "hide" || p === "hide"
                    ? "Razorpay cannot save a card or mandate for recurring payments without a phone number."
                    : undefined
              : undefined,
          ),
        )}
      </SettingsCard>

      <SettingsCard title="Billing address" meta="Printed on invoices">
        <SurfaceHeads />
        {BILLING.map((r) =>
          row(
            r,
            r.key === "billing.postal_code"
              ? (c) =>
                  c === "mandatory"
                    ? "Every checkout must send a postal code, so the gateway can verify it against the card (AVS)."
                    : "Verification (AVS) runs only when a buyer gives a postal code. Set Required to make it run every time. There is no separate AVS setting."
              : undefined,
          ),
        )}
      </SettingsCard>

      <SettingsCard title="Invoice" meta="Extra details for the buyer's invoice">
        <SurfaceHeads />
        <PoNumberRow
          defaultValue={checkout["invoice.po_number"]}
          collectsPoNumber={collectsPoNumber}
          hostedPagesHref={hostedPagesHref}
        />
      </SettingsCard>

      <SettingsCard title="Shipping address" meta="Where the buyer wants goods sent">
        <ShippingRow defaultValue={checkout["shipping.address"]} />
      </SettingsCard>
    </>
  );
}
