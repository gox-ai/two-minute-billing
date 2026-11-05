import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { minorToDecimalString } from "@/platform/currency";
import { hubspotLinks, prices, products } from "@db/schema";
import { HubSpotApiError, type HubSpotClient } from "../client";
import type { PushHandler } from "./context";
import { propertiesHash, upsertLink, type SyncOutcome } from "./links";

type Price = typeof prices.$inferSelect;

/** Link hash of a product we archived in HubSpot, so repeat pushes of an archived price are free. */
const ARCHIVED = "archived";

/** HubSpot stores one unit price per product, so only these models survive the trip intact. */
const SUPPORTED_MODELS = new Set(["flat", "per_unit"]);

/** Our (interval, count) → HubSpot `recurringbillingfrequency`. Anything else has no HubSpot equivalent. */
const FREQUENCIES: Record<string, string> = {
  "week:1": "weekly",
  "week:2": "biweekly",
  "month:1": "monthly",
  "month:3": "quarterly",
  "month:6": "per_six_months",
  "month:12": "annually",
  "month:24": "per_two_years",
  "month:36": "per_three_years",
  "month:48": "per_four_years",
  "month:60": "per_five_years",
  "year:1": "annually",
  "year:2": "per_two_years",
  "year:3": "per_three_years",
  "year:4": "per_four_years",
  "year:5": "per_five_years",
};

const LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  per_six_months: "Every 6 months",
  annually: "Yearly",
  per_two_years: "Every 2 years",
  per_three_years: "Every 3 years",
  per_four_years: "Every 4 years",
  per_five_years: "Every 5 years",
};

/**
 * Currency code → the product property that holds a price in it. A multi-currency portal has one
 * `hs_price_<code>` per enabled currency; a single-currency portal has only `price`, in the one
 * currency its deals offer. Read once per pass (one client per pass).
 */
const priceProps = new WeakMap<HubSpotClient, Promise<Map<string, string>>>();

function portalPriceProperties(client: HubSpotClient): Promise<Map<string, string>> {
  let p = priceProps.get(client);
  if (!p) {
    p = loadPriceProperties(client);
    priceProps.set(client, p);
    p.catch(() => priceProps.delete(client));
  }
  return p;
}

async function loadPriceProperties(client: HubSpotClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const body = await client.request<{ results?: Array<{ name?: string }> }>(
    "GET",
    "/crm/v3/properties/products",
  );
  for (const r of body?.results ?? []) {
    const m = /^hs_price_([a-z]{3})$/.exec(r.name ?? "");
    if (m) out.set(m[1]!.toUpperCase(), r.name!);
  }
  if (out.size > 0) return out;
  try {
    const cur = await client.request<{ options?: Array<{ value?: string }> }>(
      "GET",
      "/crm/v3/properties/deals/deal_currency_code",
    );
    const codes = (cur?.options ?? []).map((o) => o.value?.toUpperCase()).filter(Boolean);
    if (codes.length === 1) out.set(codes[0]!, "price");
  } catch (err) {
    if (!(err instanceof HubSpotApiError && err.status === 404)) throw err;
  }
  return out;
}

/** Price → HubSpot product: a monthly and a yearly price of one plan are two products. */
export const pushPrice: PushHandler = async ({ client, conn, settings }, priceId) => {
  const loaded = await withTenant(conn.organizationId, async (tx) => {
    const [row] = await tx
      .select({ price: prices, product: products })
      .from(prices)
      .innerJoin(products, eq(products.id, prices.productId))
      .where(and(eq(prices.id, priceId), eq(prices.businessId, conn.businessId)))
      .limit(1);
    if (!row) return null;
    const [link] = await tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "price"),
          eq(hubspotLinks.localId, priceId),
          eq(hubspotLinks.remoteType, "product"),
        ),
      )
      .limit(1);
    return { ...row, link: link ?? null };
  });
  if (!loaded)
    return [{ action: "skipped", localType: "price", message: "Price no longer exists" }];

  const { price, product, link } = loaded;
  const base = {
    localType: "price" as const,
    localRef: price.publicId,
    remoteType: "product" as const,
  };
  const skip = (message: string): SyncOutcome[] => [
    { ...base, action: "skipped", remoteId: link?.remoteId, message },
  ];

  if (!settings.products.enabled) return skip("Product sync is off");

  if (!price.active || !product.active) {
    if (!link) return skip("Archived and never synced");
    if (link.lastPushedHash === ARCHIVED) return skip("No changes");
    try {
      await client.request(
        "DELETE",
        `/crm/v3/objects/products/${encodeURIComponent(link.remoteId)}`,
      );
    } catch (err) {
      if (!(err instanceof HubSpotApiError && err.status === 404)) throw err;
    }
    await upsertLink(conn, {
      localType: "price",
      localId: priceId,
      remoteType: "product",
      remoteId: link.remoteId,
      hash: ARCHIVED,
    });
    return [
      { ...base, action: "updated", remoteId: link.remoteId, message: "Archived in HubSpot" },
    ];
  }

  if (!SUPPORTED_MODELS.has(price.model))
    return skip(
      `The ${price.model} pricing model cannot sync: HubSpot stores one unit price per product`,
    );
  if (price.amountMinor === null) return skip("Price has no amount");

  let frequency: string | null = null;
  if (price.type === "recurring") {
    frequency = FREQUENCIES[`${price.interval}:${price.intervalCount}`] ?? null;
    if (!frequency)
      return skip(
        `Billing every ${price.intervalCount} ${price.interval}(s) has no HubSpot billing frequency`,
      );
  }

  const priceProp = (await portalPriceProperties(client)).get(price.currency.toUpperCase());
  if (!priceProp) return skip(`${price.currency} is not a currency of this HubSpot portal`);

  const properties = buildProperties(price, product, frequency, priceProp);
  const hash = propertiesHash(properties);
  if (link && link.lastPushedHash === hash) return skip("No changes");

  const { remoteId, created } = await upsertProduct(
    client,
    link?.lastPushedHash === ARCHIVED ? null : link,
    price.publicId,
    properties,
  );
  await upsertLink(conn, {
    localType: "price",
    localId: priceId,
    remoteType: "product",
    remoteId,
    hash,
  });
  return [{ ...base, action: created ? "created" : "updated", remoteId }];
};

function buildProperties(
  price: Price,
  product: typeof products.$inferSelect,
  frequency: string | null,
  priceProp: string,
): Record<string, string> {
  const label =
    price.externalName ??
    price.name ??
    `${frequency ? LABELS[frequency] : "One-time"}, ${price.currency}`;
  const properties: Record<string, string> = {
    name: `${product.externalName ?? product.name} (${label})`,
    description: price.description ?? product.description ?? "",
    hs_sku: price.publicId,
    [priceProp]: minorToDecimalString(price.amountMinor!, price.currency),
  };
  if (frequency) {
    properties.recurringbillingfrequency = frequency;
    // Term: a fixed number of cycles. Left empty, HubSpot bills until cancelled.
    if (price.billingCycles) {
      const weeks = price.interval === "week";
      const perCycle = weeks
        ? price.intervalCount
        : price.interval === "year"
          ? price.intervalCount * 12
          : price.intervalCount;
      properties.hs_recurring_billing_period = `P${price.billingCycles * perCycle}${weeks ? "W" : "M"}`;
    }
  }
  return properties;
}

/** PATCH the linked product (re-matching if HubSpot lost it), else match on SKU, else create. */
async function upsertProduct(
  client: HubSpotClient,
  link: { remoteId: string } | null,
  sku: string,
  properties: Record<string, string>,
): Promise<{ remoteId: string; created: boolean }> {
  if (link && (await patch(client, link.remoteId, properties)))
    return { remoteId: link.remoteId, created: false };

  const found = await client.request<{ results?: Array<{ id: string }> }>(
    "POST",
    "/crm/v3/objects/products/search",
    {
      filterGroups: [{ filters: [{ propertyName: "hs_sku", operator: "EQ", value: sku }] }],
      properties: ["hs_sku"],
      limit: 1,
    },
  );
  const match = found?.results?.[0]?.id;
  if (match && (await patch(client, match, properties))) return { remoteId: match, created: false };

  const res = await client.request<{ id?: string }>("POST", "/crm/v3/objects/products", {
    properties,
  });
  if (!res?.id) throw new HubSpotApiError("HubSpot returned no product id", 502, true, res);
  return { remoteId: res.id, created: true };
}

/** False when the product is gone (deleted or archived in HubSpot). */
async function patch(
  client: HubSpotClient,
  id: string,
  properties: Record<string, string>,
): Promise<boolean> {
  try {
    await client.request("PATCH", `/crm/v3/objects/products/${encodeURIComponent(id)}`, {
      properties,
    });
    return true;
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return false;
    throw err;
  }
}
