import {
  listBusinesses,
  getProduct,
  listPrices,
  listProducts,
  listProductGroups,
  listApplicablePlans,
  listDifferentialPrices,
  listProductEntitlements,
  listFeatures,
  fmtDate,
  fmtDateTime,
  type ApplicablePlans,
  type DifferentialPrice,
  type Feature,
  type PlanEntitlement,
  type Price,
} from "@/lib/api";
import Link from "next/link";
import {
  createCheckoutLinkAction,
  createPurchaseLinkAction,
  updateProductMetadataAction,
} from "../actions";
import { allows, requirePermission } from "@/lib/session";
import { Suspense } from "react";
import { PlanUsageThresholdCard } from "@/components/usage-controls/usage-invoice-threshold-card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import {
  Facts,
  FoldedCard,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
  type FoldedSection,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { RailLink } from "@/components/patterns/action-rail";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import { PricingMatrix, freqLabel, priceDisplay } from "@/components/catalog/pricing-matrix";
import { CheckoutLinkPicker } from "@/components/catalog/checkout-link-picker";
import { PaymentLinkDialog } from "@/components/catalog/payment-link-dialog";
import { CopyButton } from "@/components/patterns/copy-button";
import { listPaymentLinks, type PaymentLink } from "@/lib/api/payment-links";
import { paymentLinkPriceOptions } from "@/lib/payment-link-options";
import { AttachAddonModal } from "@/components/catalog/attach-addon-modal";
import { quantityAppliesByProduct } from "@/lib/price-quantity";
import { AttachedItemsList, type AttachedRow } from "@/components/catalog/attached-items-list";
import { EditMetadataDialog } from "@/components/catalog/edit-metadata-dialog";
import { listEventsForBusiness, type EventRecord } from "@/lib/api/developer";
import { DifferentialGrid } from "@/components/catalog/differential-grid";
import { DifferentialOverview } from "@/components/catalog/differential-overview";
import { SetDifferentialModal } from "@/components/catalog/set-differential-modal";
import { ArchiveRestoreItem } from "@/components/catalog/catalog-record-actions";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CommentsCard } from "@/components/comments/comments-card";
import { UsageTiles } from "@/components/catalog/usage-tiles";
import { getProductStats } from "@/lib/api/catalog-stats";
import { EmptyState, ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Gift } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { creditsLinkOption, isCreditsLink, resetLabel, type CreditsLinkOption } from "@/lib/reset";
import type { PriceGrantsCredit } from "@/lib/credits";
import { PlanEntitlementDialog } from "@/components/catalog/plan-entitlement-dialog";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { noun: string; plural: string; page: string }> = {
  plan: { noun: "Plan", plural: "Plans", page: "plans" },
  addon: { noun: "Addon", plural: "Add-ons", page: "addons" },
  charge: { noun: "One-time product", plural: "One-time products", page: "charges" },
};

/** "Enabled", "Unlimited", "5 users", "1 style · renews every month". */
function entitlementValue(e: PlanEntitlement, link: CreditsLinkOption | undefined): string {
  if (e.type === "switch") return e.value === "true" ? "Enabled" : "Disabled";
  if (e.value === "unlimited") return "Unlimited";
  const v = e.unit ? `${e.value} ${e.unit}` : e.value;
  if (e.type !== "meter" || !e.reset) return v;
  if (!isCreditsLink(e.reset)) return `${v} · renews ${resetLabel(e.reset)}`;
  return link && "reset" in link
    ? `${v} · renews with the credits (${resetLabel(link.reset)})`
    : `${v} · renews with the credits`;
}

/**
 * Product detail (plan / addon / charge), record-page layout: header, figures,
 * Pricing, Selling (checkout links + applicable items for a plan; differential
 * pricing for an addon or charge), Records, then folded Product details.
 */
export default async function ProductDetail({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; prod: string }>;
  searchParams: Promise<{ plan?: string; msg?: string; error?: string }>;
}) {
  const { biz, prod } = await params;
  const { plan: selectedPlan, msg, error } = await searchParams;
  const me = await requirePermission("catalog:view", "manager");

  let businesses, product, prices, groups, allProducts;
  try {
    [businesses, product, prices, groups, allProducts] = await Promise.all([
      listBusinesses(),
      getProduct(biz, prod),
      listPrices(biz, { includeArchived: true }),
      listProductGroups(biz),
      listProducts(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Product" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  // The events endpoint filters on resource_type + resource_id, and the catalog emits
  // product_* events against exactly those. An events outage must not take the page down.
  const [itemEvents, stats, entitlements, features, productLinks] = await Promise.all([
    listEventsForBusiness(biz, { resource_type: "product", resource_id: prod, limit: 10 })
      .then((r): EventRecord[] => r.data)
      .catch((): EventRecord[] => []),
    // Figures are supplementary: a stats failure drops the two tiles, not the page.
    getProductStats(biz, prod).catch(() => null),
    // Null (not empty) on failure, so the card says it could not load rather than "none".
    listProductEntitlements(biz, prod)
      .then((r): PlanEntitlement[] => r.data)
      .catch((): PlanEntitlement[] | null => null),
    listFeatures(biz)
      .then((r): Feature[] => r.data)
      .catch((): Feature[] => []),
    // Null on failure, so the card says it could not load rather than "none".
    listPaymentLinks(biz, { product: prod })
      .then((r): PaymentLink[] => r.data)
      .catch((): PaymentLink[] | null => null),
  ]);

  const business = businesses.data.find((b) => b.id === biz);
  // Dates render in the business timezone — the engine's term boundaries are midnight there.
  const tz = business?.timezone ?? null;
  const bizName = business?.name ?? biz;
  const kind = product.kind ?? "plan";
  const kindMeta = KIND_META[kind] ?? KIND_META.plan;
  const group = groups.data.find((g) => g.id === product.product_group);
  const detailPath = `/businesses/${biz}/catalog/products/${prod}`;
  const newPriceHref = `${detailPath}/prices/new`;

  const productPrices = prices.data.filter((p) => p.product === prod);
  // "Same as the credits" (G3b) follows the one schedule of the active per-cycle prices.
  const creditsLink = creditsLinkOption(
    productPrices.flatMap((p) => {
      const gc = (p as { grants_credit?: PriceGrantsCredit | null }).grants_credit;
      return gc?.kind === "per_cycle" ? [{ active: p.active, reset: gc.reset ?? null }] : [];
    }),
  );
  const livePrices = productPrices.filter((p) => p.active !== false);
  // Grouped by currency, shortest cadence first. The price name is added only where two
  // options would otherwise read the same.
  const cadenceRank = (p: Price) =>
    p.type === "one_time" || !p.interval
      ? 99
      : (["day", "week", "month", "year"].indexOf(p.interval) + 1) * 10 + (p.interval_count ?? 1);
  const checkoutBase = (p: Price) => `${freqLabel(p)} · ${priceDisplay(p)}`;
  const checkoutSorted = [...livePrices].sort(
    (a, b) => a.currency.localeCompare(b.currency) || cadenceRank(a) - cadenceRank(b),
  );
  const checkoutOptions = checkoutSorted.map((p) => {
    const base = checkoutBase(p);
    const twin = checkoutSorted.some(
      (q) => q.id !== p.id && q.currency === p.currency && checkoutBase(q) === base,
    );
    return {
      value: p.id,
      label: twin ? `${base} · ${p.name ?? p.id}` : base,
      group: p.currency.toUpperCase(),
    };
  });
  // Which items read a quantity at all. A flat-fee item does not — the engine refuses any
  // quantity but 1 — so the attach modal omits Default quantity for it.
  const quantityByProduct = quantityAppliesByProduct(prices.data);
  // Every currency the business transacts in, plus any that already carries a price.
  const currencies = Array.from(
    new Set(
      [
        business?.default_currency,
        ...(business?.currencies ?? []),
        ...productPrices.map((p) => p.currency),
      ]
        .filter((c): c is string => !!c)
        // Prices are stored upper-cased; `businesses.currencies` is free jsonb and is not.
        .map((c) => c.toUpperCase()),
    ),
  ).sort();

  const addonsAndCharges = allProducts.data.filter((p) => (p.kind ?? "plan") !== "plan");
  const plans = allProducts.data.filter((p) => (p.kind ?? "plan") === "plan");

  /**
   * `config: null` + `via: 'all_plans'` means applicable through the addon's
   * `addon_applies_to_all`, not an attached_items row — nothing stored, nothing this
   * page can detach.
   */
  let attachedRows: AttachedRow[] = [];
  let addonLinks: ApplicablePlans | null = null;
  let differentials: DifferentialPrice[] = [];

  if (kind === "plan") {
    const links = await Promise.all(
      addonsAndCharges.map(async (a) => ({
        item: a,
        links: await listApplicablePlans(biz, a.id).catch(() => null),
      })),
    );
    attachedRows = links
      .filter((l) => l.links && (l.links.applies_to_all || l.links.plans.includes(prod)))
      .map((l) => {
        // An explicit row for THIS plan is what `plans` reports; an applies-to-all addon
        // with one reads as a normal attachment, because it is one.
        const attachedHere = l.links!.plans.includes(prod);
        const quantityApplies = quantityByProduct[l.item.id] ?? true;
        if (!attachedHere)
          return { item: l.item, config: null, via: "all_plans" as const, quantityApplies };
        return {
          item: l.item,
          via: "attached" as const,
          quantityApplies,
          config: l.links!.config?.[prod] ?? {
            applicability: l.links!.applicability[prod] ?? "optional",
            chargeOnEvent: "subscription_creation",
            chargeOnce: false,
            defaultQuantity: 1,
            billingCycles: null,
            minQuantity: null,
            maxQuantity: null,
            quantityStep: 1,
            customerCanChangeQuantity: true,
          },
        };
      });
  } else if (kind === "addon" || kind === "charge") {
    [addonLinks, differentials] = await Promise.all([
      listApplicablePlans(biz, prod).catch(() => null),
      listDifferentialPrices(biz, prod)
        .then((r) => r.data)
        .catch(() => []),
    ]);
  }

  // A charge bills once at its event, so the engine only attaches one with a one-time price.
  const oneTimePriced = new Set(
    prices.data.filter((p) => p.type === "one_time").map((p) => p.product),
  );
  const availableItems = addonsAndCharges.filter(
    (a) =>
      a.active &&
      !attachedRows.some((x) => x.item.id === a.id) &&
      (a.kind !== "charge" || oneTimePriced.has(a.id)),
  );

  // Differential grid plans: those the addon applies to, UNION any plan that already
  // carries a differential (imported catalogs have differentials without links).
  const dpPlanIds = new Set<string>(
    addonLinks ? (addonLinks.applies_to_all ? plans.map((p) => p.id) : addonLinks.plans) : [],
  );
  for (const d of differentials) dpPlanIds.add(d.plan);
  const configuredPlanIds = new Set(differentials.map((d) => d.plan));
  const dpPlans = plans
    .filter((p) => dpPlanIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, configured: configuredPlanIds.has(p.id) }));
  const selectedPlanObj = selectedPlan
    ? (dpPlans.find((p) => p.id === selectedPlan) ?? null)
    : null;

  const metaKeys = product.metadata ? Object.keys(product.metadata).length : 0;
  const lastModified = product.updated_at ?? product.created_at;
  const bizTaxCode = business?.default_tax_code ?? null;

  const detailSections: FoldedSection[] = [
    {
      id: "identity",
      title: "Identity",
      summary: [
        product.id,
        kindMeta.noun,
        group ? `group ${group.name}` : null,
        product.external_name ? `external name “${product.external_name}”` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      children: (
        <Facts
          rows={[
            { label: "ID", value: <span className="font-mono text-xs">{product.id}</span> },
            { label: "Type", value: kindMeta.noun },
            {
              label: "Product group",
              value: group ? (
                <Link
                  href={`/businesses/${biz}/catalog/product_groups/${group.id}`}
                  className="text-primary hover:underline"
                >
                  {group.name}
                </Link>
              ) : (
                "—"
              ),
            },
            { label: "External name", value: product.external_name || "—" },
            { label: "Description", value: product.description || "—" },
          ]}
        />
      ),
    },
    {
      id: "unit",
      title: "Unit of measure",
      summary: `${product.unit_of_measure || "—"} · ${product.metered ? "metered" : "not metered"}`,
      children: (
        <Facts
          rows={[
            { label: "Unit of measure", value: product.unit_of_measure || "—" },
            { label: "Metered", value: product.metered ? "Yes" : "No" },
          ]}
        />
      ),
    },
    {
      id: "tax",
      title: "Tax",
      summary: product.tax_code
        ? `Tax code ${product.tax_code}`
        : bizTaxCode
          ? `Business default · ${bizTaxCode}`
          : "No tax code",
      children: (
        <Facts
          rows={[
            {
              label: "HSN/SAC code",
              // Blank falls back to the business default, so show which one applies.
              value: product.tax_code ? (
                <span className="font-mono text-xs">{product.tax_code}</span>
              ) : bizTaxCode ? (
                <span>
                  <span className="font-mono text-xs">{bizTaxCode}</span>{" "}
                  <span className="text-muted-foreground">(business default)</span>
                </span>
              ) : (
                "—"
              ),
            },
          ]}
        />
      ),
    },
    {
      // "Display in Checkout" / "Display in Self-Serve Portal" are stored but nothing reads
      // them, so they are not shown here or on the form until a feature does.
      id: "display",
      title: "Buyers",
      summary: [
        product.image_url ? "has an image" : "no image",
        product.redirect_url ? `after payment ${product.redirect_url}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      children: (
        <Facts
          rows={[
            {
              label: "Image",
              value: product.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- a CDN image on our storage host
                <img
                  src={product.image_url}
                  alt=""
                  className="size-16 rounded-md border bg-card object-cover"
                />
              ) : (
                "—"
              ),
            },
            { label: "After-payment page", value: product.redirect_url || "—" },
            kind !== "plan"
              ? {
                  label: "Applies to all plans",
                  value: product.addon_applies_to_all ? "Yes" : "No",
                }
              : null,
          ]}
        />
      ),
    },
    {
      id: "metadata",
      title: "JSON metadata",
      summary: metaKeys ? `${metaKeys} key${metaKeys === 1 ? "" : "s"}` : "None",
      children: (
        <div className="flex items-start gap-3">
          {metaKeys ? (
            <pre className="min-w-0 flex-1 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(product.metadata, null, 2)}
            </pre>
          ) : (
            <span className="flex-1 text-sm text-muted-foreground">No metadata.</span>
          )}
          <EditMetadataDialog
            action={updateProductMetadataAction}
            hidden={{ biz, prod }}
            metadata={product.metadata}
          />
        </div>
      ),
    },
    {
      id: "modified",
      title: "Last modified",
      summary: lastModified ? fmtDateTime(lastModified, tz) : "—",
      children: (
        <Facts
          rows={[
            { label: "Last modified", value: lastModified ? fmtDateTime(lastModified, tz) : "—" },
            { label: "Created", value: product.created_at ? fmtDate(product.created_at, tz) : "—" },
          ]}
        />
      ),
    },
  ];

  const grantedKeys = new Set((entitlements ?? []).map((e) => e.feature));
  const addableFeatures = features.filter((f) => f.active && !grantedKeys.has(f.key));
  const entitlementsCard = (
    <RecordCard
      id="entitlements"
      title="Entitlements"
      meta={entitlements?.length ? `${entitlements.length}` : undefined}
      flush={!!entitlements?.length}
      actions={
        // Features are created through the API; with none left to grant there is nothing to add.
        entitlements && addableFeatures.length > 0 ? (
          <PlanEntitlementDialog
            biz={biz}
            prod={prod}
            features={addableFeatures}
            creditsLink={creditsLink}
            trigger={
              <button type="button" className="text-primary hover:underline">
                Add entitlement
              </button>
            }
          />
        ) : null
      }
    >
      {entitlements === null ? (
        <ErrorState description="We could not load the entitlements." />
      ) : entitlements.length === 0 ? (
        <EmptyState
          icon={<Gift />}
          title="No entitlements"
          description={
            features.length === 0
              ? "This business has no features yet. Create them with POST /v1/businesses/:biz/features. Then grant them here."
              : "This product grants no features yet."
          }
        />
      ) : (
        <Paged
          items={entitlements.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="pl-5 wrap-break-word whitespace-normal">
                {e.feature_name}
              </TableCell>
              <TableCell className="truncate font-mono text-xs text-muted-foreground">
                {e.feature}
              </TableCell>
              <TableCell className="tabular-nums">{entitlementValue(e, creditsLink)}</TableCell>
              <TableCell className="pr-5 text-right">
                <PlanEntitlementDialog
                  biz={biz}
                  prod={prod}
                  features={[]}
                  edit={e}
                  creditsLink={creditsLink}
                  trigger={
                    <button type="button" className="text-primary hover:underline">
                      Edit
                    </button>
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        >
          <Table className="table-fixed">
            <colgroup>
              <col />
              <col className="w-[30%]" />
              <col className="w-[22%]" />
              <col className="w-20" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Feature</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="pr-5">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <PagedItems />
            </TableBody>
          </Table>
          <PagedFooter />
        </Paged>
      )}
    </RecordCard>
  );

  const checkoutCard = (
    <RecordCard id="checkout" title="Hosted checkout">
      {checkoutOptions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add an active price to create a checkout link.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <p className="min-w-0 flex-1 basis-80 text-sm text-muted-foreground">
            {kind === "charge"
              ? "Create a link for one buyer to buy this product. The link works until the buyer pays or until it expires. We show the expiry time when you create the link."
              : "Create a link for one buyer to subscribe to this plan. The link works until the buyer subscribes or until it expires. We show the expiry time when you create the link."}
          </p>
          <CheckoutLinkPicker
            options={checkoutOptions}
            mint={(kind === "charge" ? createPurchaseLinkAction : createCheckoutLinkAction).bind(
              null,
              biz,
            )}
          />
        </div>
      )}
    </RecordCard>
  );

  const linkPicker = paymentLinkPriceOptions(prices.data, allProducts.data);
  const paymentLinksCard = (
    <RecordCard
      id="payment-links"
      title="Payment links"
      meta={productLinks ? String(productLinks.length) : undefined}
      flush
      actions={
        livePrices.length > 0 ? (
          <PaymentLinkDialog
            biz={biz}
            options={linkPicker.options}
            meta={linkPicker.meta}
            initialPrice={livePrices[0]!.id}
          />
        ) : null
      }
    >
      {productLinks === null ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          We could not load the payment links.
        </p>
      ) : productLinks.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No payment link sells this product. A payment link works for any number of buyers.
        </p>
      ) : (
        <ul className="divide-y">
          {productLinks.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{l.name}</div>
                <div className="text-xs text-muted-foreground">
                  {l.opens} opened · {l.completions} completed
                </div>
              </div>
              {l.url ? (
                <span className="flex min-w-0 items-center gap-1 text-xs">
                  <span className="max-w-72 truncate font-mono">{l.url}</span>
                  <CopyButton value={l.url} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </RecordCard>
  );

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: kindMeta.plural, href: `/businesses/${biz}/catalog/${kindMeta.page}` },
          { label: product.name },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={product.name}
        chips={
          <>
            <StatusChip status={product.active ? "active" : "archived"} />
            <Chip>{kindMeta.noun}</Chip>
          </>
        }
        facts={[
          product.description,
          group ? (
            <Link
              key="grp"
              href={`/businesses/${biz}/catalog/product_groups/${group.id}`}
              className="hover:text-foreground hover:underline"
            >
              {group.name}
            </Link>
          ) : null,
          <IdChip key="id" label="Product ID" id={product.id} />,
        ]}
        actions={
          <>
            <Button asChild>
              <Link href={`${detailPath}/edit`}>Edit</Link>
            </Button>
            <MoreMenu>
              <MoreSection heading="Pricing">
                <RailLink href={newPriceHref}>Add price</RailLink>
              </MoreSection>
              <MoreSection heading={kindMeta.noun}>
                <ArchiveRestoreItem
                  biz={biz}
                  resource="products"
                  id={product.id}
                  active={product.active}
                  noun={product.name}
                  archiveDescription="You cannot add an archived product to new subscriptions. Existing subscriptions continue to work."
                  restoreDescription="You can add the product to new subscriptions again."
                />
              </MoreSection>
            </MoreMenu>
          </>
        }
      />

      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {error ? <ErrorState description={error} /> : null}

      <UsageTiles stats={stats} scope={kind} currency={business?.default_currency} />

      <Zone title="Pricing">
        <Row span="12">
          <RecordCard
            id="pricing"
            title="Pricing"
            flush
            actions={
              <Link href={newPriceHref} className="text-primary hover:underline">
                Add price
              </Link>
            }
          >
            <PricingMatrix
              biz={biz}
              productId={prod}
              prices={productPrices}
              currencies={currencies}
            />
          </RecordCard>
        </Row>
        {kind === "plan" &&
        productPrices.some((p) => p.metered) &&
        allows(me, "usage_controls:view", "manager") ? (
          <Row span="12">
            <Suspense fallback={null}>
              <PlanUsageThresholdCard
                biz={biz}
                product={prod}
                prices={productPrices}
                canManage={allows(me, "usage_controls:manage", "manager")}
              />
            </Suspense>
          </Row>
        ) : null}
      </Zone>

      {kind === "plan" ? (
        <Zone title="Selling">
          {/* Full width: one line of controls, so a half-width cell only stretched it. */}
          <Row span="12">{checkoutCard}</Row>
          <Row span="12">{paymentLinksCard}</Row>
          <Row span="12">
            <RecordCard
              id="applicable"
              title="Applicable add-ons and one-time products"
              actions={
                <AttachAddonModal
                  biz={biz}
                  plan={prod}
                  addons={availableItems}
                  quantityApplies={quantityByProduct}
                />
              }
            >
              {/* Only a row backed by a real attached_items row may offer Detach;
                  AttachedItemsList owns that rule. */}
              <AttachedItemsList biz={biz} plan={prod} rows={attachedRows} />
            </RecordCard>
          </Row>
          <Row span="12">{entitlementsCard}</Row>
        </Zone>
      ) : (
        <Zone title="Selling">
          <Row span="12">
            <RecordCard
              id="differential"
              title="Differential pricing"
              actions={<SetDifferentialModal plans={dpPlans} />}
            >
              {selectedPlanObj ? (
                <DifferentialGrid
                  biz={biz}
                  addon={product}
                  plan={selectedPlanObj}
                  currencies={currencies}
                  rows={differentials}
                />
              ) : (
                <DifferentialOverview
                  biz={biz}
                  addon={product}
                  plans={dpPlans}
                  rows={differentials}
                />
              )}
            </RecordCard>
          </Row>
          {kind === "addon" ? <Row span="12">{entitlementsCard}</Row> : null}
          {kind === "charge" ? <Row span="12">{checkoutCard}</Row> : null}
          {kind === "charge" ? <Row span="12">{paymentLinksCard}</Row> : null}
        </Zone>
      )}

      <Zone title="Records">
        <Row span="8/4">
          <ActivityLogCard
            biz={biz}
            resourceType="product"
            resourceId={prod}
            tz={tz}
            layout="card"
            previewRows={5}
          />
          <CommentsCard
            biz={biz}
            resourceType="product"
            resourceId={prod}
            backPath={detailPath}
            layout="card"
          />
        </Row>
        {itemEvents.length > 0 ? (
          <Row span="12">
            <RecordCard id="events" title="Events" flush>
              <Paged
                size={5}
                items={itemEvents.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5"
                  >
                    <Link
                      href={`/businesses/${biz}/events/${e.id}`}
                      className="text-primary hover:underline"
                    >
                      {e.type}
                    </Link>
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-xs text-muted-foreground">{e.id}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {fmtDateTime(e.occurred_at, tz)}
                      </span>
                    </span>
                  </li>
                ))}
              >
                <ul className="divide-y text-sm">
                  <PagedItems />
                </ul>
                <PagedFooter />
              </Paged>
            </RecordCard>
          </Row>
        ) : null}
      </Zone>

      <div className="mt-4">
        <FoldedCard
          title="Product details"
          sections={detailSections}
          actions={
            <Link href={`${detailPath}/edit`} className="text-primary hover:underline">
              Edit
            </Link>
          }
        />
      </div>
    </div>
  );
}
