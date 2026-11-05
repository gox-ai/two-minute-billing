"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImageIcon, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProductImageSupport } from "@/lib/api/product-images";
import { createProductAction, editProductAction } from "@/app/actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/ui/select-field";
import { SwitchField } from "@/components/ui/switch";
import { CurrencySelect } from "@/components/form/currency-select";
import type { Crumb } from "@/components/page-header";
import type { Product, ProductGroup } from "@/lib/api";
import {
  ChoiceCards,
  FormCard,
  FormFrame,
  FrequencyField,
  LockedField,
  MetadataEditor,
  SummaryCard,
  SwitchRow,
  TextField,
  Wide,
  adjective,
  defaultFrequency,
  everyPhrase,
  metaJson,
  metaRows,
  slugError,
  suggestSlug,
  useFormModel,
  type Interval,
  type MetaRow,
} from "@/components/catalog/form-kit";
import {
  MODEL_LABEL,
  PricingFields,
  priceSentence,
  pricingSeed,
  type PricingValues,
} from "@/components/catalog/pricing-fields";

type Kind = "plan" | "addon" | "charge";
const NOUN: Record<Kind, string> = { plan: "Plan", addon: "Addon", charge: "One-time product" };

export interface ProductFormBusiness {
  default_currency?: string | null;
  currencies?: string[] | null;
  billing_frequencies?: Array<{ interval: Interval; count: number }> | null;
  default_tax_behavior?: "exclusive" | "inclusive";
  /** Price type per currency; a currency here overrides `default_tax_behavior`. */
  tax_behavior_by_currency?: Record<string, string> | null;
  /** Resolved business default HSN/SAC; null = none, so blank prints no code. */
  default_tax_code?: string | null;
}

interface Values {
  name: string;
  code: string;
  external_name: string;
  product_group: string;
  description: string;
  unit_of_measure: string;
  metered: boolean;
  redirect_url: string;
  tax_code: string;
  addon_applies_to_all: boolean;
  meta: MetaRow[];
  // first price (create only)
  with_price: boolean;
  currency: string;
  interval: string;
  count: string;
  pricing: PricingValues;
  trial_period: string;
  trial_unit: string;
  trial_end_action: string;
  cycles: "forever" | "fixed";
  billing_cycles: string;
  tax_behavior: string;
  // first one-time price: the fields an online shop and its accountant need
  sku: string;
  accounting_code: string;
  accounting_category_code: string;
  is_taxable: boolean;
}

const FIELD_LABEL: Partial<Record<keyof Values, string>> = {
  name: "Internal name",
  external_name: "External name",
  product_group: "Product group",
  description: "Description",
  unit_of_measure: "Unit of measure",
  metered: "Metered",
  redirect_url: "After-payment page",
  tax_code: "HSN/SAC code",
  addon_applies_to_all: "Plans",
  meta: "Metadata",
};

/**
 * Plan / addon / charge create and edit. Create also takes the first price
 * (product first, then the price: two calls — if the price fails, the action
 * reopens the product's own price form). Edit sends `expected_version`, so a
 * concurrent save is refused rather than overwritten.
 */
export function ProductForm({
  biz,
  kind,
  groups,
  product,
  defaultGroup,
  listHref,
  returnTo,
  crumbs,
  business = {},
  priceCount,
  imageSupport,
}: {
  biz: string;
  kind: Kind;
  groups: ProductGroup[];
  /** present → edit mode */
  product?: Product;
  defaultGroup?: string;
  listHref: string;
  /** where the action lands after submit (detail on create, self on edit) */
  returnTo?: string;
  crumbs: Crumb[];
  business?: ProductFormBusiness;
  /** Edit only: how many prices the product has. */
  priceCount?: number;
  /** Whether this deployment stores images, and which types. Absent = no picker. */
  imageSupport?: ProductImageSupport;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const editing = !!product;
  const noun = NOUN[kind] ?? "Plan";
  const lower = noun.toLowerCase();
  const target = returnTo || listHref;
  const freq = defaultFrequency(business.billing_frequencies);

  const seedCurrency = (
    business.default_currency ??
    business.currencies?.[0] ??
    "USD"
  ).toUpperCase();
  const taxBehaviorFor = (cur: string) =>
    business.tax_behavior_by_currency?.[cur] ?? business.default_tax_behavior ?? "exclusive";
  const seed: Values = {
    name: product?.name ?? "",
    code: product?.id ?? "",
    external_name: product?.external_name ?? "",
    product_group: product?.product_group ?? defaultGroup ?? groups[0]?.id ?? "",
    description: product?.description ?? "",
    unit_of_measure: product?.unit_of_measure ?? "",
    metered: !!product?.metered,
    redirect_url: product?.redirect_url ?? "",
    tax_code: product?.tax_code ?? "",
    addon_applies_to_all: !!product?.addon_applies_to_all,
    meta: metaRows(product?.metadata),
    with_price: !editing,
    currency: seedCurrency,
    interval: freq.interval,
    count: freq.count,
    pricing: pricingSeed(null, kind === "plan" ? "per_unit" : "flat"),
    trial_period: "",
    trial_unit: "day",
    trial_end_action: "activate_subscription",
    cycles: "forever",
    billing_cycles: "",
    tax_behavior: taxBehaviorFor(seedCurrency),
    sku: "",
    accounting_code: "",
    accounting_category_code: "",
    is_taxable: true,
  };
  const [v, set] = useFormModel(seed, formRef);
  const setPricing = (patch: Partial<PricingValues>) => set("pricing", { ...v.pricing, ...patch });

  const oneTime = kind === "charge";

  // The image is not part of the server action (whose body is capped at 1 MB): it is held
  // here and uploaded once the product exists, through /api/product-image.
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [imageRemoved, setImageRemoved] = React.useState(false);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const localPreview = React.useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : null),
    [imageFile],
  );
  React.useEffect(
    () => () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    },
    [localPreview],
  );
  const imageUrl = localPreview ?? (imageRemoved ? null : (product?.image_url ?? null));
  const pickImage = (file: File | undefined) => {
    if (!file) return;
    if (imageSupport?.accepts.length && !imageSupport.accepts.includes(file.type))
      return setImageError("Select a PNG, JPEG, GIF or WebP image.");
    if (file.size > 5 * 1024 * 1024)
      return setImageError("The image is too large. The maximum size is 5 MB.");
    setImageError(null);
    setImageRemoved(false);
    setImageFile(file);
  };

  /** After the product saves: send the image change, then leave. */
  async function finish(redirectTo: string | undefined) {
    const dest = redirectTo ?? target;
    const prod = product?.id ?? dest.split("#")[0]!.split("/").pop();
    let failed: string | null = null;
    // The upload runs after the save and can take a few seconds: say so, or the page looks stuck.
    const busy =
      prod && (imageFile || (imageRemoved && product?.image_url))
        ? toast.loading(imageFile ? "Saving the image…" : "Removing the image…")
        : null;
    if (prod && imageFile) {
      const fd = new FormData();
      fd.set("biz", biz);
      fd.set("prod", prod);
      fd.set("file", imageFile);
      const res = await fetch("/api/product-image", { method: "POST", body: fd });
      if (!res.ok)
        failed = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
    } else if (prod && imageRemoved && product?.image_url) {
      const q = new URLSearchParams({ biz, prod });
      const res = await fetch(`/api/product-image?${q}`, { method: "DELETE" });
      if (!res.ok)
        failed = ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
    }
    if (busy !== null) toast.dismiss(busy);
    if (failed !== null)
      toast.error(`The ${lower} is saved, but we could not change its image. ${failed}`.trim());
    // A new one-time product lands on its links: the next step is selling it.
    router.push(!editing && oneTime && redirectTo ? `${dest}#payment-links` : dest);
  }
  // A new plan asks for its unit beside the price it qualifies.
  const uomInPrice = kind === "plan" && !editing && v.with_price;
  const codeError = editing ? undefined : slugError(v.code, suggestSlug(v.name) || `team-${lower}`);
  const groupName = groups.find((g) => g.id === v.product_group)?.name ?? v.product_group;
  const unit = v.unit_of_measure.trim();

  // ── summary ──
  const period = oneTime ? null : adjective(v.interval, Number(v.count) || 1);
  const periodPhrase = oneTime ? null : everyPhrase(v.interval, Number(v.count) || 1);
  const cost = priceSentence(v.pricing, v.currency, unit, periodPhrase);
  const trialDays = Number(v.trial_period);
  const trialText =
    kind === "plan" && trialDays > 0 ? `${trialDays}-${v.trial_unit} free trial` : null;
  let lead: string;
  if (editing) {
    lead = [v.name || `Unnamed ${lower}`, groupName].filter(Boolean).join(" · ");
  } else if (!v.with_price) {
    lead = `Creates the ${lower} with no price. Add a price on its page.`;
  } else if (!cost) {
    lead = "Enter a price to see what customers pay.";
  } else if (kind === "plan") {
    lead = `Customers pay ${cost}${trialText ? `, with a ${trialText}` : ""}.`;
  } else if (kind === "addon") {
    lead = `Adds ${cost} to ${v.addon_applies_to_all ? "any plan" : "the plans it is attached to"}.`;
  } else {
    lead = `Buyers pay ${cost} once.`;
  }

  const changed = editing
    ? [
        ...(Object.keys(FIELD_LABEL) as Array<keyof Values>)
          .filter((k) =>
            k === "meta"
              ? metaJson(v.meta).json !== metaJson(seed.meta).json
              : JSON.stringify(v[k]) !== JSON.stringify(seed[k]),
          )
          .map((k) => FIELD_LABEL[k]!),
        ...(imageFile || (imageRemoved && product?.image_url) ? ["Image"] : []),
      ]
    : [];

  const taxHelp = business.default_tax_code
    ? `Tax invoices show this code. If empty, we use this business's default, ${business.default_tax_code}.`
    : "Tax invoices show this code. This business has no default. If empty, tax invoices show no code.";

  // "Display in Checkout" / "Display in Self-Serve Portal" are left off: the columns are
  // stored, but no checkout or portal reads them yet, and a switch that does nothing is
  // worse than none. The API still accepts both.
  const redirectField = (
    <TextField
      name="redirect_url"
      label="After-payment page"
      value={v.redirect_url}
      onChange={(x) => set("redirect_url", x)}
      help="Checkout sends the buyer here after payment, if the checkout link or payment link has no page of its own. For example, a thank-you or download page."
      placeholder="https://"
      maxLength={2000}
    />
  );
  const appliesToAll = (
    <SwitchRow
      name="addon_applies_to_all"
      label="Applies to all plans"
      hint={`Every plan can use this ${lower}. Disable it to select plans on the ${lower} page.`}
      checked={v.addon_applies_to_all}
      onCheckedChange={(c) => set("addon_applies_to_all", c)}
    />
  );
  const selling = oneTime ? (
    <FormCard title="How you sell it" columns={1}>
      <div className="space-y-1">
        <p className="text-sm font-medium">On its own</p>
        <p className="text-sm text-muted-foreground">
          Sell it with a checkout link or a payment link on its page. The buyer pays once and gets a
          paid invoice. No subscription is made.
        </p>
      </div>
      {redirectField}
      <div className="space-y-1 border-t pt-4">
        <p className="text-sm font-medium">With a subscription</p>
        <p className="text-sm text-muted-foreground">
          Add it to a subscription, for example as a setup fee. We bill it on the next invoice.
        </p>
      </div>
      {appliesToAll}
    </FormCard>
  ) : (
    <FormCard title="After payment" columns={1}>
      {redirectField}
      {kind === "plan" && !editing ? meteredRow() : null}
    </FormCard>
  );

  const imageCard = imageSupport?.uploadEnabled ? (
    <FormCard title="Image" columns={1}>
      <div className="flex items-center gap-4">
        <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50 text-muted-foreground">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview or a CDN image
            <img src={imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <ImageIcon className="size-6" aria-hidden />
          )}
        </span>
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-muted-foreground">
            Buyers see it on checkout, payment links, the pricing page and their purchases. PNG,
            JPEG, GIF or WebP, up to 5 MB.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              {imageUrl ? "Change image" : "Select image"}
            </Button>
            {imageUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setImageFile(null);
                  setImageRemoved(true);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              >
                Remove image
              </Button>
            ) : null}
          </div>
          {imageError ? <p className="text-sm text-destructive">{imageError}</p> : null}
          {/* No name: the file must not ride in the server action's body. */}
          <input
            ref={fileRef}
            type="file"
            accept={imageSupport.accepts.join(",")}
            className="sr-only"
            aria-label="Product image"
            onChange={(e) => pickImage(e.target.files?.[0])}
          />
        </div>
      </div>
    </FormCard>
  ) : null;

  // What the buyer sees on checkout, from the values on this form.
  const taxNote = !v.is_taxable
    ? "No tax"
    : v.tax_behavior === "inclusive"
      ? "Tax included"
      : "Tax added at checkout";
  const buyerPreview = oneTime ? (
    <div className="space-y-2">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Buyers see
      </p>
      <div className="flex items-start gap-3 rounded-md border bg-card p-3">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50 text-muted-foreground">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview or a CDN image
            <img src={imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <Package className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {v.external_name.trim() || v.name.trim() || `Unnamed ${lower}`}
          </p>
          {v.description.trim() ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{v.description.trim()}</p>
          ) : null}
          {!editing && v.with_price && cost ? (
            <p className="mt-1 text-sm tabular-nums">
              {cost} <span className="text-xs text-muted-foreground">· {taxNote}</span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  ) : null;

  function meteredRow() {
    return (
      <SwitchRow
        name="metered"
        label="Usage-based (metered)"
        hint="Catalog lists and the API show it as metered. To bill usage, use a Usage pricing model on the price."
        checked={v.metered}
        onCheckedChange={(c) => set("metered", c)}
      />
    );
  }

  return (
    <ActionForm
      action={editing ? editProductAction : createProductAction}
      onSuccess={(r) => void finish(r.redirectTo)}
      formRef={formRef}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="kind" value={kind} />
      {editing ? (
        <>
          <input type="hidden" name="prod" value={product!.id} />
          {oneTime ? null : <input type="hidden" name="metered_present" value="1" />}
          {kind !== "plan" ? (
            <input type="hidden" name="addon_applies_to_all_present" value="1" />
          ) : null}
          {product!.resource_version != null ? (
            <input type="hidden" name="expected_version" value={product!.resource_version} />
          ) : null}
        </>
      ) : null}
      {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
      {!editing && v.with_price ? <PriceHidden oneTime={oneTime} /> : null}

      <FormFrame
        crumbs={crumbs}
        title={editing ? `Edit ${product!.name}` : `New ${lower}`}
        description={
          editing
            ? "Changes apply to new invoices. Issued invoices do not change."
            : kind === "plan"
              ? "A subscription starts from a plan. Add its first price now. You can add more currencies and frequencies later."
              : kind === "addon"
                ? "An item that a subscription adds to its plan. We bill it with the plan."
                : "Something you sell once: a product, a credit pack or a setup fee. Sell it on its own, or add it to a subscription."
        }
        cancelHref={listHref}
        submitLabel={editing ? "Save changes" : `Create ${lower}`}
        summary={
          <SummaryCard
            lead={lead}
            rows={[
              !editing && { label: noun, value: [v.name || "—", groupName].join(" · ") },
              !editing &&
                v.with_price && {
                  label: "Price",
                  value: [v.currency, period ?? "one-time", MODEL_LABEL[v.pricing.model]]
                    .filter(Boolean)
                    .join(" · ")
                    .toLowerCase()
                    .replace(/^[a-z]{3}/, (c) => c.toUpperCase()),
                },
              !editing &&
                v.with_price &&
                !oneTime && {
                  label: "Renews",
                  value:
                    v.cycles === "fixed" && v.billing_cycles
                      ? `${v.billing_cycles} cycle${v.billing_cycles === "1" ? "" : "s"}`
                      : "Forever",
                },
              !editing &&
                !!trialText && {
                  label: "After trial",
                  value:
                    v.trial_end_action === "cancel_subscription"
                      ? "Cancel the subscription"
                      : "Activate and charge",
                },
              kind === "addon" && {
                label: "Applies to",
                value: v.addon_applies_to_all ? "All plans" : "Attached plans",
              },
              oneTime && {
                label: "Sold",
                value: `On its own · with ${v.addon_applies_to_all ? "any plan" : "the plans you select"}`,
              },
              editing && {
                label: "Prices",
                value: `${priceCount ?? 0} · edit them on the ${lower} page`,
              },
              !!v.redirect_url.trim() && { label: "After payment", value: v.redirect_url.trim() },
              editing && {
                label: "Changed",
                value: changed.length ? changed.join(", ") : "Nothing yet",
              },
            ]}
            note={
              editing
                ? "If another person saves this after you open it, Save stops. You can then load their version."
                : v.with_price
                  ? oneTime
                    ? `Creates the ${lower} and its first price. Its page then has the checkout link and payment link.`
                    : `Creates the ${lower}, then its first price.`
                  : undefined
            }
          >
            {buyerPreview}
          </SummaryCard>
        }
      >
        <FormCard title={noun}>
          <TextField
            name="name"
            label="Internal name"
            required
            value={v.name}
            onChange={(x) => set("name", x)}
            maxLength={200}
          />
          {editing ? (
            <LockedField
              label={`${noun} ID`}
              value={product!.id}
              mono
              reason="You cannot change an ID. The API and existing subscriptions use it."
            />
          ) : (
            <TextField
              name="code"
              label={`${noun} ID`}
              value={v.code}
              onChange={(x) => set("code", x)}
              error={codeError}
              help="If empty, we make one from the name."
              placeholder={suggestSlug(v.name) || `team-${lower}`}
              maxLength={100}
              mono
            />
          )}
          <TextField
            name="external_name"
            label="External name"
            value={v.external_name}
            onChange={(x) => set("external_name", x)}
            help="Customers see it on invoices and checkout"
            maxLength={200}
          />
          <Field name="product_group" label="Product group" required>
            <SelectField
              name="product_group"
              value={v.product_group}
              onValueChange={(x) => set("product_group", x)}
              required
              ariaLabel="Product group"
              placeholder={groups.length === 0 ? "No product groups" : "Select a product group…"}
              options={groups.map((g) => ({ value: g.id, label: g.name }))}
            />
          </Field>
          <Wide>
            <Field name="description" label="Description">
              <Textarea
                name="description"
                value={v.description}
                onChange={(e) => set("description", e.target.value)}
                rows={3}
                maxLength={2000}
              />
            </Field>
          </Wide>
          {uomInPrice ? null : (
            <TextField
              name="unit_of_measure"
              label="Unit of measure"
              value={v.unit_of_measure}
              onChange={(x) => set("unit_of_measure", x)}
              help={
                unit ? `Printed after the quantity: 5 ${unit}s` : "For example, seat, agent, GB"
              }
              maxLength={100}
            />
          )}
          {oneTime || (kind === "plan" && !editing) ? null : (
            <div className="flex items-end pb-1">{meteredRow()}</div>
          )}
        </FormCard>

        {editing ? null : (
          <FormCard
            title="First price"
            actions={
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                Add now
                <SwitchField
                  name="with_price"
                  value="1"
                  checked={v.with_price}
                  onCheckedChange={(c) => set("with_price", c)}
                  ariaLabel="Add the first price now"
                />
              </span>
            }
            columns={oneTime ? 2 : 3}
          >
            {v.with_price ? (
              <>
                <Field name="pp_currency" label="Currency" required>
                  <CurrencySelect
                    name="pp_currency"
                    value={v.currency}
                    onValueChange={(c) => {
                      set("currency", c);
                      // The first price follows the selected currency's price type.
                      set("tax_behavior", taxBehaviorFor(c.toUpperCase()));
                    }}
                    options={business.currencies}
                  />
                </Field>
                {oneTime ? (
                  <LockedField
                    label="Frequency"
                    value="One-time"
                    reason="We bill a charge one time."
                  />
                ) : (
                  <Field name="pp_interval" label="Frequency">
                    <FrequencyField
                      prefix="pp_"
                      allowed={business.billing_frequencies}
                      interval={v.interval}
                      count={v.count}
                      onChange={(i, c) => {
                        set("interval", i);
                        set("count", c);
                      }}
                    />
                  </Field>
                )}
                <PricingFields
                  prefix="pp_"
                  values={v.pricing}
                  onChange={setPricing}
                  currency={v.currency}
                  unitLabel={unit || undefined}
                  recurring={!oneTime}
                />
                {oneTime ? (
                  <TextField
                    name="pp_sku"
                    label="SKU"
                    value={v.sku}
                    onChange={(x) => set("sku", x)}
                    help="Your own stock code. We keep it with the price and return it in the API."
                    maxLength={200}
                    mono
                  />
                ) : null}
                {uomInPrice ? (
                  <TextField
                    name="unit_of_measure"
                    label="Unit of measure"
                    value={v.unit_of_measure}
                    onChange={(x) => set("unit_of_measure", x)}
                    help={
                      unit
                        ? `Printed after the quantity: 5 ${unit}s`
                        : "For example, seat, agent, GB"
                    }
                    maxLength={100}
                  />
                ) : null}
                {kind === "plan" ? (
                  <>
                    <Field
                      name="pp_trial_period"
                      label="Trial period"
                      help="Leave empty for no trial"
                    >
                      <div className="flex gap-2">
                        <Input
                          name="pp_trial_period"
                          type="number"
                          min={0}
                          value={v.trial_period}
                          onChange={(e) => set("trial_period", e.target.value)}
                          className="w-24 tabular-nums"
                        />
                        <SelectField
                          name="pp_trial_period_unit"
                          value={v.trial_unit}
                          onValueChange={(x) => set("trial_unit", x)}
                          ariaLabel="Trial period unit"
                          options={["day", "week", "month", "year"].map((u) => ({
                            value: u,
                            label: `${u}s`,
                          }))}
                        />
                      </div>
                    </Field>
                    <Field name="pp_trial_end_action" label="When the trial ends">
                      <SelectField
                        name="pp_trial_end_action"
                        value={v.trial_end_action}
                        onValueChange={(x) => set("trial_end_action", x)}
                        ariaLabel="When the trial ends"
                        options={[
                          { value: "activate_subscription", label: "Activate and charge" },
                          { value: "cancel_subscription", label: "Cancel the subscription" },
                        ]}
                      />
                    </Field>
                  </>
                ) : null}
                {oneTime ? null : (
                  <Field name="pp_billing_cycles" label="Billing cycles">
                    <div className="flex gap-2">
                      <SelectField
                        value={v.cycles}
                        onValueChange={(x) => set("cycles", x as Values["cycles"])}
                        ariaLabel="Billing cycles"
                        options={[
                          { value: "forever", label: "Forever, until cancelled" },
                          { value: "fixed", label: "A fixed number" },
                        ]}
                      />
                      {v.cycles === "fixed" ? (
                        <Input
                          name="pp_billing_cycles"
                          aria-label="Number of billing cycles"
                          type="number"
                          min={1}
                          required
                          value={v.billing_cycles}
                          onChange={(e) => set("billing_cycles", e.target.value)}
                          className="w-24 tabular-nums"
                        />
                      ) : null}
                    </div>
                  </Field>
                )}
              </>
            ) : (
              <Wide>
                <p className="text-sm text-muted-foreground">
                  We create the {lower} without a price. Customers cannot subscribe to it until it
                  has a price.
                </p>
              </Wide>
            )}
          </FormCard>
        )}

        {kind === "addon" ? (
          <FormCard title="Applicability" columns={1}>
            {appliesToAll}
          </FormCard>
        ) : null}

        {imageCard}

        {selling}

        {oneTime && !editing && v.with_price ? (
          // The price form also offers "invoice notes" and "show the description on
          // invoices"; nothing prints either yet, so they are not offered here.
          <FormCard title="Accounting">
            <TextField
              name="pp_accounting_code"
              label="Accounting code"
              value={v.accounting_code}
              onChange={(x) => set("accounting_code", x)}
              help="The ledger account in your accounting system. We keep it with the price."
              maxLength={200}
            />
            <TextField
              name="pp_accounting_category_code"
              label="Accounting category"
              value={v.accounting_category_code}
              onChange={(x) => set("accounting_category_code", x)}
              help="The class or category in your accounting system"
              maxLength={200}
            />
          </FormCard>
        ) : null}

        <FormCard title="Tax and metadata">
          <TextField
            name="tax_code"
            label="HSN/SAC code"
            value={v.tax_code}
            onChange={(x) => set("tax_code", x)}
            help={taxHelp}
            placeholder={business.default_tax_code ?? ""}
            maxLength={20}
            mono
          />
          {oneTime && !editing && v.with_price ? (
            <Wide>
              <input type="hidden" name="pp_is_taxable_present" value="1" />
              <SwitchRow
                name="pp_is_taxable"
                label="Taxable"
                hint="Disable it for an item that has no tax, for example a gift card"
                checked={v.is_taxable}
                onCheckedChange={(c) => set("is_taxable", c)}
              />
            </Wide>
          ) : null}
          {!editing && v.with_price ? (
            <Field name="pp_tax_behavior" label="Tax behavior">
              <ChoiceCards
                name="pp_tax_behavior"
                value={v.tax_behavior}
                onValueChange={(x) => set("tax_behavior", x)}
                ariaLabel="Tax behavior"
                options={[
                  { value: "exclusive", label: "Exclusive", hint: "Price excludes tax" },
                  { value: "inclusive", label: "Inclusive", hint: "Price includes tax" },
                ]}
              />
            </Field>
          ) : (
            <div />
          )}
          <Wide>
            <MetadataEditor rows={v.meta} onChange={(rows) => set("meta", rows)} />
          </Wide>
        </FormCard>
      </FormFrame>
    </ActionForm>
  );
}

/** The price type, which no visible control posts. */
function PriceHidden({ oneTime }: { oneTime: boolean }) {
  return <input type="hidden" name="pp_type" value={oneTime ? "one_time" : "recurring"} />;
}
