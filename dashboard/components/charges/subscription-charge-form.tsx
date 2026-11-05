"use client";

import * as React from "react";
import { useActionState } from "react";
import { CatalogItemModal } from "@/components/subscriptions/catalog-item-modal";
import {
  ChargeFrame,
  AddChargeTrigger,
  chargeCount,
  type DraftCharge,
} from "@/components/charges/charge-takeover";
import { RecordCard } from "@/components/patterns/record-page";
import { ChoiceCardsField } from "@/components/subscriptions/sub-form-frame";
import { money } from "@/lib/format";
import { QuickChargeModal } from "@/components/charges/quick-charge-modal";
import { addSubscriptionChargesAction } from "@/app/actions";
import type { Price, Product } from "@/lib/api";

let seq = 0;
const nextKey = () => `s${++seq}`;

/**
 * Subscription-level `Add Charge` (catalog) and `Create Quick Charge` (ad-hoc).
 *
 * Differs from the customer-scope form in exactly two ways:
 *  - **No currency picker.** Currency is the subscription's, so there is no field here.
 *  - **An invoicing choice.** Unbilled charges are subscription-scoped, so this scope
 *    can defer. Customer scope always invoices.
 */
export function SubscriptionChargeForm({
  biz,
  sub,
  mode,
  currency,
  chargePrices,
  products,
  businessName,
  planName,
  customerName,
}: {
  biz: string;
  sub: string;
  businessName: string;
  planName: string;
  customerName?: string | null;
  mode: "catalog" | "quick";
  currency: string;
  /** Already filtered to the subscription's currency by the page. */
  chargePrices: Price[];
  products: Product[];
}) {
  const [result, formAction, pending] = useActionState(addSubscriptionChargesAction, null);
  const [drafts, setDrafts] = React.useState<DraftCharge[]>([]);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [invoiceNow, setInvoiceNow] = React.useState("true");

  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const addDraft = (d: Omit<DraftCharge, "key">) =>
    setDrafts((prev) => [...prev, { ...d, key: nextKey() }]);
  const removeDraft = (key: string) => setDrafts((prev) => prev.filter((d) => d.key !== key));

  const onPickCatalogPrice = (priceId: string) => {
    const price = chargePrices.find((p) => p.id === priceId);
    if (!price) return;
    const prod = productById.get(price.product);
    addDraft({
      description: prod?.name ?? price.name ?? price.product,
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
  const now = invoiceNow === "true";

  return (
    <form action={formAction}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />

      <ChargeFrame
        crumbs={[
          { label: businessName, href: `/businesses/${biz}` },
          { label: "Subscriptions", href: `/businesses/${biz}/subscriptions` },
          {
            label: customerName ? `${planName} · ${customerName}` : planName,
            href: `/businesses/${biz}/subscriptions/${sub}`,
          },
          { label: title },
        ]}
        title={title}
        description={
          <>
            One-off charges on this subscription, billed in {currency}.{" "}
            {isQuick
              ? "Enter each amount and its service period."
              : "Select them from the catalog."}
          </>
        }
        cancelHref={`/businesses/${biz}/subscriptions/${sub}`}
        currency={currency}
        drafts={drafts}
        onRemove={removeDraft}
        submitLabel={n === 0 ? "Add charges" : `Add ${chargeCount(n)}`}
        pending={pending}
        error={result && !result.ok ? (result.message ?? "We could not add the charges.") : null}
        summaryLead={
          n === 0
            ? "No charges yet. Add one to preview what is billed."
            : now
              ? `${chargeCount(n)}, ${money(total, currency)}, invoiced now and collected from the payment method.`
              : `${chargeCount(n)}, ${money(total, currency)}, held as unbilled charges until the next renewal.`
        }
        summaryRows={[
          { label: "Subscription", value: planName },
          customerName ? { label: "Customer", value: customerName } : null,
          { label: "Currency", value: currency },
          { label: "Subtotal", value: money(total, currency) },
          { label: "When", value: now ? "Invoice immediately" : "Next renewal" },
        ]}
        addControl={
          isQuick ? (
            <AddChargeTrigger label={addLabel} onClick={() => setModalOpen(true)} />
          ) : chargePrices.length > 0 ? (
            <CatalogItemModal
              title="Add Charge"
              options={chargePrices}
              productById={productById}
              searchPlaceholder="Search Charges"
              onSelect={onPickCatalogPrice}
            />
          ) : null
        }
        emptyHint={
          !isQuick && chargePrices.length === 0 ? (
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
        after={
          <RecordCard title="Invoicing">
            {/* Preselects "Invoice immediately" (user-approved). The API's own
                `invoice_now` defaults to false, so the choice is always explicit on the wire. */}
            <ChoiceCardsField
              name="invoice_now"
              ariaLabel="When to invoice"
              value={invoiceNow}
              onValueChange={setInvoiceNow}
              options={[
                {
                  value: "true",
                  label: "Invoice immediately",
                  hint: "Raises an invoice now and tries to collect from the payment method.",
                },
                {
                  value: "false",
                  label: "Add to unbilled charges",
                  hint: "We hold the charges on this subscription and bill them at the next renewal. No money moves now.",
                },
              ]}
            />
          </RecordCard>
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
