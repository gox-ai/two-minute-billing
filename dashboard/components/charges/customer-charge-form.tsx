"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CurrencySelect } from "@/components/form/currency-select";
import { Field } from "@/components/form/field";
import { CatalogItemModal } from "@/components/subscriptions/catalog-item-modal";
import {
  ChargeFrame,
  AddChargeTrigger,
  chargeCount,
  type DraftCharge,
} from "@/components/charges/charge-takeover";
import { RecordCard } from "@/components/patterns/record-page";
import { money } from "@/lib/format";
import { QuickChargeModal } from "@/components/charges/quick-charge-modal";
import { addChargeAction } from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";
import type { Price, Product } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

let seq = 0;
const nextKey = () => `d${++seq}`;

/**
 * Customer-level `Add Charge` (catalog) and `Create Quick Charge` (ad-hoc).
 *
 * Both are the same page with a different add-control, so they share one
 * component: `mode` picks the catalog picker or the ad-hoc modal. Drafts accumulate
 * client-side and post as one invoice (see `addChargeAction`).
 *
 * Currency lives on the page rather than inside the per-charge modal because an
 * invoice is single-currency — a per-line picker would have to silently lock itself
 * after the first line. Changing it clears the drafts, since a catalog price is
 * currency-specific and an amount typed in one currency is not the same amount in
 * another.
 */
export function CustomerChargeForm({
  biz,
  cus,
  mode,
  defaultCurrency,
  bizCurrencies,
  chargePrices,
  products,
  businessName,
  customerName,
  autoCollection,
}: {
  biz: string;
  cus: string;
  businessName: string;
  customerName: string;
  autoCollection?: "on" | "off" | null;
  mode: "catalog" | "quick";
  defaultCurrency: string;
  bizCurrencies: string[] | null;
  /** Charge-kind prices across all currencies; filtered to the picked one below. */
  chargePrices: Price[];
  /** Passed as an array — a Map can't cross the server/client boundary. */
  products: Product[];
}) {
  const router = useRouter();
  const submit = async (prev: ActionResult | null, formData: FormData) => {
    const r = await addChargeAction(prev, formData);
    if (r.ok) {
      if (r.message) toast.success(r.message);
      if (r.redirectTo) router.push(r.redirectTo);
    }
    return r;
  };
  const [result, formAction, pending] = useActionState(submit, null);
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [drafts, setDrafts] = React.useState<DraftCharge[]>([]);
  const [modalOpen, setModalOpen] = React.useState(false);

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const pricesInCurrency = React.useMemo(
    () => chargePrices.filter((p) => p.currency === currency),
    [chargePrices, currency],
  );

  const addDraft = (d: Omit<DraftCharge, "key">) =>
    setDrafts((prev) => [...prev, { ...d, key: nextKey() }]);
  const removeDraft = (key: string) => setDrafts((prev) => prev.filter((d) => d.key !== key));

  const onPickCatalogPrice = (priceId: string) => {
    const price = chargePrices.find((p) => p.id === priceId);
    if (!price) return;
    const prod = productById.get(price.product);
    addDraft({
      description: prod?.name ?? price.name ?? price.product,
      // The API rates a catalog line itself; we carry the amount only so the
      // takeover can show a subtotal before committing.
      amountMinor: price.amount_minor ?? 0,
      price: price.id,
      quantity: 1,
    });
  };

  const isQuick = mode === "quick";
  const addLabel = isQuick ? "Add Quick Charge" : "Add Charge";
  const n = drafts.length;
  const total = drafts.reduce((s, d) => s + d.amountMinor, 0);
  const title = isQuick ? "Create quick charge" : "Add charge";

  return (
    <form action={formAction}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <input type="hidden" name="currency" value={currency} />
      {/* Customer-scope charges always invoice — unbilled charges are subscription-scoped.
          `collect` lets the engine attempt the card per the customer's auto-collection. */}
      <input type="hidden" name="collect" value="1" />
      <input type="hidden" name="apply_tax" value="1" />

      <ChargeFrame
        crumbs={[
          { label: businessName, href: `/businesses/${biz}` },
          { label: "Customers", href: `/businesses/${biz}/customers` },
          { label: customerName, href: `/businesses/${biz}/customers/${cus}` },
          { label: title },
        ]}
        title={title}
        description={
          <>
            One-off charges for this customer, invoiced together in {currency}.{" "}
            {isQuick
              ? "Enter each amount and its service period."
              : "Select them from the catalog."}
          </>
        }
        cancelHref={`/businesses/${biz}/customers/${cus}`}
        currency={currency}
        drafts={drafts}
        onRemove={removeDraft}
        submitLabel={n === 0 ? "Add charges" : `Add ${chargeCount(n)}`}
        pending={pending}
        error={result && !result.ok ? (result.message ?? "We could not add the charges.") : null}
        summaryLead={
          n === 0
            ? "No charges yet. Add one to preview the invoice."
            : `${chargeCount(n)}, ${money(total, currency)}, invoiced now to ${customerName}.`
        }
        summaryRows={[
          { label: "Customer", value: customerName },
          { label: "Currency", value: currency },
          { label: "Subtotal", value: money(total, currency) },
          { label: "When", value: "Invoiced now" },
          autoCollection
            ? {
                label: "Collection",
                value: autoCollection === "off" ? "Auto-collection off" : "Auto-collection on",
              }
            : null,
        ]}
        before={
          <RecordCard title="Currency">
            <Field
              name="currency_display"
              label="Select Currency"
              required
              className="max-w-xs"
              error={result && !result.ok ? result.errors?.currency_display : undefined}
              help={n > 0 ? "Changing the currency clears the charges below." : undefined}
            >
              <CurrencySelect
                name="currency_display"
                value={currency}
                onValueChange={(v) => {
                  setCurrency(v);
                  setDrafts([]);
                }}
                options={bizCurrencies}
              />
            </Field>
          </RecordCard>
        }
        addControl={
          isQuick ? (
            <AddChargeTrigger label={addLabel} onClick={() => setModalOpen(true)} />
          ) : pricesInCurrency.length > 0 ? (
            <CatalogItemModal
              title="Add Charge"
              options={pricesInCurrency}
              productById={productById}
              searchPlaceholder="Search Charges"
              onSelect={onPickCatalogPrice}
            />
          ) : null
        }
        emptyHint={
          !isQuick && pricesInCurrency.length === 0 ? (
            // Rule 0: an empty picker is a dead control — say why instead.
            <>
              The catalog has no charges in {currency}.{" "}
              <a
                href={`/businesses/${biz}/catalog/products`}
                className="font-semibold text-primary hover:underline"
              >
                Add one to the catalog
              </a>
              , or use Create Quick Charge for a one-off charge.
            </>
          ) : (
            <>
              No charges added. Use <b className="text-foreground">{addLabel}</b> to add one.
            </>
          )
        }
      />

      {isQuick ? (
        <QuickChargeModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          currency={currency}
          onAdd={addDraft}
        />
      ) : null}
    </form>
  );
}
