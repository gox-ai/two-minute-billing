/**
 * Catalog usage stats, coupon redemptions, per-customer coupon cap, coupon-set rename,
 * catalog comments and catalog audit rows.
 *
 *  - product / price / group stats match a raw-SQL reference; cancelled, paused and
 *    deleted subscriptions must not count, in-trial counts with 0 MRR, currencies stay apart
 *  - another business's subscriptions never leak in, and its ids 404
 *  - coupon stats: redemptions + discount given (raw-SQL reference, voided excluded);
 *    discount given is net of non-voided credit notes, per currency
 *  - redemptions list tiles under a small limit, total on the first page only
 *  - max_redemptions_per_customer: a second redemption by the same customer is a 400,
 *    another customer is allowed; signup/change estimates and a checkout page refuse the
 *    capped customer too, and a page with no customer yet accepts the code
 *  - PATCH coupon_sets/:set renames and audits; comments on product / coupon / group
 *
 *   pnpm verify:catalog-stats
 */
import { and, eq, sql } from "drizzle-orm";
import { coupons as couponsTable } from "@db/schema";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, createProductGroup } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  applyCouponToSubscription,
  createCouponSet,
  removeDiscount,
  CouponError,
} from "@/modules/coupons/service";
import { apportion } from "@/modules/catalog/stats";
import { subscriptions, auditLogs, invoices, customers, invoiceLineItems } from "@db/schema";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, pass: boolean, detail?: string) => checks.push([name, pass, detail]);
const j = JSON.stringify;

const org = await createOrganization({ name: "Catalog Stats Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
let keyN = 0;
const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "idempotency-key": `catalog-stats-${keyN++}` }),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
};

const biz = await createBusiness({
  organizationId: orgId,
  name: "Stats Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const other = await createBusiness({
  organizationId: orgId,
  name: "Other Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const B = `/v1/businesses/${biz.publicId}`;
const O = `/v1/businesses/${other.publicId}`;

const group = await createProductGroup({
  organizationId: orgId,
  businessId: biz.id,
  name: "Core",
  id: "core",
});
const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Team",
  id: "team",
  productGroupPublicId: "core",
});
const addon = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Seats",
  id: "seats",
  kind: "addon",
  productGroupPublicId: "core",
});
const mkPrice = (productId: string, id: string, currency: string, amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId,
    id,
    type: "recurring",
    model: "per_unit",
    currency,
    amountMinor,
    interval: "month",
  });
const teamUsd = await mkPrice(plan.id, "team-usd", "USD", 10000);
const teamInr = await mkPrice(plan.id, "team-inr", "INR", 50000);
const seatsUsd = await mkPrice(addon.id, "seats-usd", "USD", 2500);

let emailN = 0;
async function mkSub(
  bizId: string,
  items: Array<{ price: typeof teamUsd; quantity: number }>,
  opts: { trialDays?: number; customerId?: string } = {},
) {
  let customerId = opts.customerId;
  if (!customerId) {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: bizId,
      email: `stats-${emailN++}@example.com`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer,
      token: "tok_4242",
    });
    customerId = customer.id;
  }
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId,
    now: new Date(),
    items,
    ...(opts.trialDays ? { trialDays: opts.trialDays } : {}),
  });
  return subscription;
}
const setRow = (id: string, patch: Partial<typeof subscriptions.$inferInsert>) =>
  withTenant(orgId, (tx) => tx.update(subscriptions).set(patch).where(eq(subscriptions.id, id)));

// ── §1 fixtures: every status the stats must include or exclude ──────────────────
const sActive = await mkSub(biz.id, [
  { price: teamUsd, quantity: 1 },
  { price: seatsUsd, quantity: 2 },
]); // 10000 + 5000
const sTrial = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }], { trialDays: 14 });
const sInr = await mkSub(biz.id, [{ price: teamInr, quantity: 1 }]);
const sCancelled = await mkSub(biz.id, [{ price: teamUsd, quantity: 3 }]);
const sPaused = await mkSub(biz.id, [{ price: teamUsd, quantity: 4 }]);
const sDeleted = await mkSub(biz.id, [{ price: teamUsd, quantity: 5 }]);
// The mrr is LEFT non-zero on purpose: if the status filter broke, it would show up.
await setRow(sCancelled.id, { status: "cancelled" });
await setRow(sPaused.id, { status: "paused" });
await setRow(sDeleted.id, { deletedAt: new Date() });

// Another business carrying a same-named product: must never leak in.
const otherPlan = await createProduct({
  organizationId: orgId,
  businessId: other.id,
  name: "Team",
  id: "team",
});
const otherPrice = await createPrice({
  organizationId: orgId,
  businessId: other.id,
  productId: otherPlan.id,
  id: "team-usd",
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 70000,
  interval: "month",
});
await mkSub(other.id, [{ price: otherPrice, quantity: 1 }]);

/** Raw-SQL reference. Per-unit monthly fixtures, so an item's gross is amount × quantity. */
async function reference(where: "product" | "price", internalId: string, statuses: string[]) {
  return withTenant(orgId, async (tx) => {
    const r = await tx.execute(sql`
      select s.currency, count(distinct s.id)::int as n,
             coalesce(sum(case when s.status = 'active'
               then s.mrr * (p.amount_minor * si.quantity) / tot.g else 0 end), 0)::text as mrr
      from subscriptions s
      join subscription_items si on si.subscription_id = s.id
      join prices p on p.id = si.price_id
      join lateral (select sum(p2.amount_minor * si2.quantity) g
                    from subscription_items si2 join prices p2 on p2.id = si2.price_id
                    where si2.subscription_id = s.id) tot on true
      where s.business_id = ${biz.id}
        and s.status in (${sql.join(
          statuses.map((x) => sql`${x}`),
          sql`, `,
        )})
        and s.deleted_at is null
        and ${where === "product" ? sql`p.product_id = ${internalId}` : sql`p.id = ${internalId}`}
      group by s.currency order by s.currency`);
    const rows = (r as unknown as { rows?: any[] }).rows ?? (r as unknown as any[]);
    return {
      n: rows.reduce((a: number, x: any) => a + Number(x.n), 0),
      mrr: rows
        .map((x: any) => ({
          currency: String(x.currency).toUpperCase(),
          amount_minor: Number(x.mrr),
        }))
        .filter((x: any) => x.amount_minor !== 0),
    };
  });
}
const nonZero = (m: Array<{ currency: string; amount_minor: number }>) =>
  m.filter((x) => x.amount_minor !== 0);

// ── §2 product stats ──────────────────────────────────────────────────────────────
{
  const res = await call("GET", `${B}/products/team/stats`);
  const ref = await reference("product", plan.id, ["active", "in_trial"]);
  const mutant = await reference("product", plan.id, ["active", "in_trial", "cancelled", "paused"]);
  check("product stats 200 + object", res.status === 200 && res.body.object === "product_stats");
  check(
    "product active_subscriptions = raw SQL (active + in_trial, not deleted)",
    res.body.active_subscriptions === ref.n && ref.n === 3,
    `api=${res.body.active_subscriptions} ref=${ref.n}`,
  );
  check(
    "the fixture exercises the status filter (cancelled + paused would change the count)",
    mutant.n === ref.n + 2,
    `mutant=${mutant.n}`,
  );
  check("in_trial_subscriptions counted", res.body.in_trial_subscriptions === 1);
  check(
    "product MRR per currency = raw SQL apportionment, never summed across currencies",
    j(nonZero(res.body.mrr)) === j(ref.mrr) && ref.mrr.length === 2,
    `api=${j(res.body.mrr)} ref=${j(ref.mrr)}`,
  );
  const cross = await call("GET", `${O}/products/team/stats`);
  check(
    "same product id in the other business sees only its own subscription",
    cross.status === 200 &&
      cross.body.active_subscriptions === 1 &&
      j(nonZero(cross.body.mrr)) === j([{ currency: "USD", amount_minor: 70000 }]),
    j(cross.body),
  );
  const missing = await call("GET", `${O}/products/seats/stats`);
  check("a product of another business 404s", missing.status === 404);
}

// ── §3 price + group stats ────────────────────────────────────────────────────────
{
  const res = await call("GET", `${B}/prices/seats-usd/stats`);
  const ref = await reference("price", seatsUsd.id, ["active", "in_trial"]);
  check(
    "price stats = raw SQL",
    res.status === 200 &&
      res.body.object === "price_stats" &&
      res.body.active_subscriptions === ref.n &&
      j(nonZero(res.body.mrr)) === j(ref.mrr),
    `api=${j(res.body)} ref=${j(ref)}`,
  );
  const g = await call("GET", `${B}/product_groups/core/stats`);
  const team = g.body.products?.find((p: any) => p.product === "team");
  const seats = g.body.products?.find((p: any) => p.product === "seats");
  check(
    "group counts a subscription with two of its products once",
    g.status === 200 && g.body.active_subscriptions === 3,
    `group=${g.body.active_subscriptions}`,
  );
  check(
    "group per-product rows present",
    team?.active_subscriptions === 3 && seats?.active_subscriptions === 1,
    j(g.body.products),
  );
  const usd = (m: any[]) => m.find((x) => x.currency === "USD")?.amount_minor ?? 0;
  const [storedActive] = await withTenant(orgId, (tx) =>
    tx
      .select({ mrr: subscriptions.mrr })
      .from(subscriptions)
      .where(eq(subscriptions.id, sActive.id)),
  );
  check(
    "products of a subscription sum back to its stored MRR",
    usd(team.mrr) + usd(seats.mrr) === Number(storedActive!.mrr) &&
      usd(g.body.mrr) === Number(storedActive!.mrr),
    `team=${usd(team.mrr)} seats=${usd(seats.mrr)} stored=${storedActive!.mrr}`,
  );
  check(
    "apportion keeps the total exact on an uneven split",
    j(apportion(100n, [1n, 1n, 1n]).map(Number)) === j([34, 33, 33]) &&
      apportion(0n, [5n]).every((x) => x === 0n),
  );
}

// ── §4 coupon: per-customer cap, stats, redemptions list ─────────────────────────
{
  const created = await call("POST", `${B}/coupons`, {
    code: "ONCEEACH",
    kind: "percentage",
    percent_off_bps: 1000,
    duration_type: "forever",
    max_redemptions_per_customer: 1,
  });
  check(
    "coupon create stores max_redemptions_per_customer",
    created.status === 201 && created.body.max_redemptions_per_customer === 1,
    j(created.body),
  );
  const custA = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }]);
  const custA2 = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }], {
    customerId: custA.customerId,
  });
  const custB = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }]);
  const first = await call("POST", `${B}/subscriptions/${custA.publicId}/discount`, {
    code: "ONCEEACH",
  });
  const second = await call("POST", `${B}/subscriptions/${custA2.publicId}/discount`, {
    code: "ONCEEACH",
  });
  const otherCust = await call("POST", `${B}/subscriptions/${custB.publicId}/discount`, {
    code: "ONCEEACH",
  });
  check("first redemption by a customer allowed", first.status === 201, j(first.body));
  check(
    "second redemption by the same customer is a clear 400",
    second.status === 400 && /per customer/.test(second.body?.error?.message ?? ""),
    j(second.body),
  );
  check("a different customer may redeem", otherCust.status === 201, j(otherCust.body));
  // Removing the discount does not give the slot back.
  await removeDiscount(orgId, custA.id, "ONCEEACH");
  let reapplied = "applied";
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: custA.id,
      code: "ONCEEACH",
      now: new Date(),
    });
  } catch (e) {
    reapplied = e instanceof CouponError ? "refused" : String(e);
  }
  check("a removed redemption still counts toward the cap", reapplied === "refused", reapplied);

  // Estimates refuse a capped customer the way the apply does; one with no payer prices on.
  const [cusA] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, custA.customerId)),
  );
  const cusFresh = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `stats-${emailN++}@example.com`,
  });
  const signupBody = { items: [{ price: "team-usd", quantity: 1 }], coupon_ids: ["ONCEEACH"] };
  const estCapped = await call(
    "POST",
    `${B}/customers/${cusA!.publicId}/subscription_estimate`,
    signupBody,
  );
  check(
    "signup estimate for a customer at the cap is a 400",
    estCapped.status === 400 && /per customer/.test(estCapped.body?.error?.message ?? ""),
    j(estCapped.body),
  );
  const estFresh = await call(
    "POST",
    `${B}/customers/${cusFresh.publicId}/subscription_estimate`,
    signupBody,
  );
  check(
    "same signup estimate for another customer is discounted",
    estFresh.status === 200 && estFresh.body.discount_minor > 0,
    j(estFresh.body),
  );
  const changeCapped = await call("POST", `${B}/subscriptions/${custA2.publicId}/estimate`, {
    coupon_code: "ONCEEACH",
  });
  check(
    "change estimate for a customer at the cap is a 400",
    changeCapped.status === 400 && /per customer/.test(changeCapped.body?.error?.message ?? ""),
    j(changeCapped.body),
  );
  const custC = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }], {
    customerId: cusFresh.id,
  });
  const changeFresh = await call("POST", `${B}/subscriptions/${custC.publicId}/estimate`, {
    coupon_code: "ONCEEACH",
  });
  check(
    "same change estimate for another customer succeeds",
    changeFresh.status === 200,
    j(changeFresh.body),
  );
  const pageCapped = await call("POST", `${B}/checkout_sessions`, {
    mode: "change",
    subscription: custA2.publicId,
    coupons: ["ONCEEACH"],
  });
  check(
    "checkout page for a customer at the cap is a 400",
    pageCapped.status === 400 && /per customer/.test(pageCapped.body?.error?.message ?? ""),
    j(pageCapped.body),
  );
  const pageNew = await call("POST", `${B}/checkout_sessions`, {
    price: "team-usd",
    coupons: ["ONCEEACH"],
  });
  check(
    "checkout page with no customer yet accepts the code",
    pageNew.status === 201,
    j(pageNew.body),
  );
  const lifted = await call("PATCH", `${B}/coupons/ONCEEACH`, {
    max_redemptions_per_customer: null,
  });
  check(
    "cap is editable after redemption (null lifts it)",
    lifted.status === 200 && lifted.body.max_redemptions_per_customer === null,
    j(lifted.body),
  );

  // Five more redemptions, then bill two of them so a discount lands on invoices.
  const more: Array<typeof custA> = [];
  for (let i = 0; i < 5; i++) {
    const s = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }]);
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      code: "ONCEEACH",
      now: new Date(),
    });
    more.push(s);
  }
  const billed: Array<{ publicId: string }> = [];
  for (const s of more.slice(0, 2)) {
    const fresh = await withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(subscriptions).where(eq(subscriptions.id, s.id)).limit(1))[0]!,
    );
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: fresh,
      periodStart: fresh.currentPeriodStart!,
      periodEnd: fresh.currentPeriodEnd!,
    });
    billed.push(invoice);
  }
  // Auto-collection paid it, so it cannot be voided through ops; flip the status directly —
  // only the stats filter is under test here.
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ status: "voided" }).where(eq(invoices.publicId, billed[1]!.publicId)),
  );

  const stats = await call("GET", `${B}/coupons/ONCEEACH/stats`);
  const [ref] = await withTenant(orgId, async (tx) => {
    const r = await tx.execute(sql`
      select (select count(*)::int from applied_coupons ac join coupons c on c.id = ac.coupon_id
              where c.business_id = ${biz.id} and c.code = 'ONCEEACH') as n,
             (select coalesce(sum(d.amount_minor), 0)::text from invoice_line_discounts d
              join applied_coupons ac on ac.id = d.applied_coupon_id
              join coupons c on c.id = ac.coupon_id
              join invoices i on i.id = d.invoice_id
              where c.business_id = ${biz.id} and c.code = 'ONCEEACH' and i.status <> 'voided') as given`);
    return (r as unknown as { rows?: any[] }).rows ?? (r as unknown as any[]);
  });
  const given = stats.body.discount_given?.find((x: any) => x.currency === "USD")?.amount_minor;
  check(
    "coupon stats redemptions = raw SQL (removed included)",
    stats.status === 200 && stats.body.redemptions === Number(ref.n) && Number(ref.n) === 7,
    `api=${stats.body.redemptions} ref=${ref.n}`,
  );
  check(
    "discount given = raw SQL, voided invoice excluded, non-zero",
    given === Number(ref.given) && given > 0,
    `api=${given} ref=${ref.given}`,
  );

  const seen: string[] = [];
  let cursor: string | null = null;
  let firstTotal: number | null = null;
  let laterTotals: Array<number | null> = [];
  let pages = 0;
  do {
    const page = await call(
      "GET",
      `${B}/coupons/ONCEEACH/redemptions?limit=2${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (pages === 0) firstTotal = page.body.total;
    else laterTotals.push(page.body.total);
    seen.push(...page.body.data.map((r: any) => r.id));
    cursor = page.body.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  check(
    "redemptions tile under limit=2 with no duplicates",
    seen.length === 7 && new Set(seen).size === 7 && pages === 4,
    `seen=${seen.length} pages=${pages}`,
  );
  check(
    "total on the first page only",
    firstTotal === 7 && laterTotals.every((t) => t === null),
    `first=${firstTotal} later=${j(laterTotals)}`,
  );
  const top = await call("GET", `${B}/coupons/ONCEEACH/redemptions?limit=50`);
  const billedRow = top.body.data.find((r: any) => r.subscription === more[0]!.publicId);
  check(
    "a redemption row carries customer, invoice and its discount",
    billedRow?.invoice === billed[0]!.publicId &&
      billedRow?.discount_minor > 0 &&
      typeof billedRow?.customer === "string" &&
      billedRow?.currency === "USD",
    j(billedRow),
  );
  const bad = await call("GET", `${B}/coupons/ONCEEACH/redemptions?q=x`);
  check("redemptions refuse search", bad.status === 400);
  const cross = await call("GET", `${O}/coupons/ONCEEACH/stats`);
  check("a coupon of another business 404s", cross.status === 404);
}

// ── §4b discount given is NET of credit notes ─────────────────────────────────────
{
  const mk = await call("POST", `${B}/coupons`, {
    code: "NETCPN",
    kind: "percentage",
    percent_off_bps: 2000,
    duration_type: "forever",
  });
  check("NETCPN created", mk.status === 201, j(mk.body));
  const billWith = async (code: string, price: typeof teamUsd) => {
    const s = await mkSub(biz.id, [{ price, quantity: 1 }]);
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      code,
      now: new Date(),
    });
    const fresh = await withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(subscriptions).where(eq(subscriptions.id, s.id)).limit(1))[0]!,
    );
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: fresh,
      periodStart: fresh.currentPeriodStart!,
      periodEnd: fresh.currentPeriodEnd!,
    });
    const [line] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoiceLineItems)
        .where(
          sql`${invoiceLineItems.invoiceId} = ${invoice.id} and ${invoiceLineItems.kind} = 'recurring'`,
        ),
    );
    return { invoice, line: line! };
  };
  const credit = async (invoice: string, amount: number, line?: string) =>
    call("POST", `${B}/credit_notes`, {
      invoice,
      kind: "refundable",
      reason_code: "other",
      items: [
        {
          description: "Credit",
          amount_minor: amount,
          ...(line ? { invoice_line_item: line } : {}),
        },
      ],
    });
  const netOf = (l: { amountMinor: bigint; discountMinor: bigint }) =>
    Number(l.amountMinor - l.discountMinor);

  const full = await billWith("NETCPN", teamUsd); // 10000, 2000 off
  const half = await billWith("NETCPN", teamUsd);
  const part = await billWith("NETCPN", teamUsd);
  const voided = await billWith("NETCPN", teamUsd);
  const inr = await billWith("NETCPN", teamInr); // 50000, 10000 off
  const otherCpn = await billWith("ONCEEACH", teamUsd);
  const cns = [
    await credit(full.invoice.publicId, netOf(full.line), full.line.publicId),
    await credit(half.invoice.publicId, Number(half.invoice.totalMinor) / 2),
    await credit(part.invoice.publicId, netOf(part.line) / 4, part.line.publicId),
    await credit(voided.invoice.publicId, netOf(voided.line), voided.line.publicId),
    await credit(inr.invoice.publicId, netOf(inr.line) / 4, inr.line.publicId),
    await credit(otherCpn.invoice.publicId, netOf(otherCpn.line), otherCpn.line.publicId),
  ];
  check(
    "fixture credit notes issued",
    cns.every((c) => c.status === 201),
    j(cns.map((c) => c.body?.error?.message ?? c.status)),
  );
  const v = await call("POST", `${B}/credit_notes/${cns[3]!.body.id}/void`, {});
  check("fixture credit note voided", v.status === 200, j(v.body));

  // Reference: the attribution rule written straight in SQL.
  const refRows = await withTenant(orgId, async (tx) => {
    const r = await tx.execute(sql`
      with d as (
        select i.id inv, i.currency, d.invoice_line_item_id line, sum(d.amount_minor) disc
        from invoice_line_discounts d
        join applied_coupons ac on ac.id = d.applied_coupon_id
        join coupons c on c.id = ac.coupon_id
        join invoices i on i.id = d.invoice_id
        where c.business_id = ${biz.id} and c.code = 'NETCPN' and i.status <> 'voided'
        group by 1, 2, 3),
      cn as (select * from credit_notes where status <> 'voided'),
      linked as (
        select d.line, sum(round(d.disc::numeric * it.amount_minor
                 / nullif(li.amount_minor - li.discount_minor, 0))) r
        from d join credit_note_items it on it.invoice_line_item_id = d.line
        join cn on cn.id = it.credit_note_id
        join invoice_line_items li on li.id = d.line
        group by 1),
      whole as (
        select d.line, sum(round(d.disc::numeric * (cn.total_minor + coalesce(
                 (select sum(x.amount_minor) from credit_note_discounts x
                  where x.credit_note_id = cn.id), 0)) / nullif(i.total_minor, 0))) r
        from d join cn on cn.invoice_id = d.inv
        join invoices i on i.id = d.inv
        where not exists (select 1 from credit_note_items it
                          where it.credit_note_id = cn.id and it.invoice_line_item_id is not null)
        group by 1)
      select d.currency, sum(d.disc)::text gross,
             sum(least(d.disc, coalesce(l.r, 0) + coalesce(w.r, 0)))::text reversed
      from d left join linked l on l.line = d.line left join whole w on w.line = d.line
      group by 1 order by 1`);
    return (r as unknown as { rows?: any[] }).rows ?? (r as unknown as any[]);
  });
  const st = await call("GET", `${B}/coupons/NETCPN/stats`);
  const pick = (f: string, cur: string) =>
    st.body[f]?.find((x: any) => x.currency === cur)?.amount_minor;
  const api = ["INR", "USD"].map((cur) => ({
    currency: cur,
    gross: pick("discount_gross", cur),
    reversed: pick("discount_reversed", cur),
    given: pick("discount_given", cur),
  }));
  check(
    "gross / reversed = raw-SQL reference, per currency",
    j(api.map((a) => [a.currency, a.gross, a.reversed])) ===
      j(refRows.map((r: any) => [r.currency.toUpperCase(), Number(r.gross), Number(r.reversed)])),
    `api=${j(api)} ref=${j(refRows)}`,
  );
  // USD: 4 × 2000 gross; full credit 2000 + half 1000 + quarter 500; the voided note nothing.
  const usd = api.find((a) => a.currency === "USD")!;
  check(
    "USD: fully credited → 0, half → half, quarter → quarter, voided note ignored",
    usd.gross === 8000 && usd.reversed === 3500 && usd.given === 4500,
    j(usd),
  );
  const inrRow = api.find((a) => a.currency === "INR")!;
  check(
    "INR kept apart: a quarter of 10000 reversed",
    inrRow.gross === 10000 && inrRow.reversed === 2500 && inrRow.given === 7500,
    j(inrRow),
  );
  check(
    "currencies never summed",
    st.body.discount_given?.length === 2 && st.body.discount_gross?.length === 2,
    j(st.body),
  );
  const once = await call("GET", `${B}/coupons/ONCEEACH/stats`);
  const onceUsd = (f: string) =>
    once.body[f]?.find((x: any) => x.currency === "USD")?.amount_minor ?? 0;
  check(
    "another coupon's credited invoice reverses only that coupon",
    onceUsd("discount_reversed") === Number(otherCpn.line.discountMinor) &&
      onceUsd("discount_given") === onceUsd("discount_gross") - onceUsd("discount_reversed"),
    j(once.body),
  );
}

// ── §4c estimates refuse a coupon the apply would refuse ─────────────────────────
{
  const day = 86_400_000;
  const mk = (code: string, extra: Record<string, unknown>) =>
    call("POST", `${B}/coupons`, {
      code,
      kind: "percentage",
      percent_off_bps: 1000,
      duration_type: "forever",
      ...extra,
    });
  await mk("GONE", { redeem_by: new Date(Date.now() - day).toISOString() });
  await mk("SOON", { valid_from: new Date(Date.now() + 30 * day).toISOString() });
  await mk("ONESHOT", { max_redemptions: 1 });
  await mk("FINE", {});
  const holder = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }]);
  const used = await call("POST", `${B}/subscriptions/${holder.publicId}/discount`, {
    code: "ONESHOT",
  });
  check("max_redemptions 1: the first redemption is allowed", used.status === 201, j(used.body));

  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `stats-${emailN++}@example.com`,
  });
  const sub = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }], { customerId: cus.id });
  const cases: Array<[string, RegExp]> = [
    ["GONE", /has expired/],
    ["SOON", /not yet valid/],
    ["ONESHOT", /redemption limit/],
  ];
  for (const [code, why] of cases) {
    const signup = await call("POST", `${B}/customers/${cus.publicId}/subscription_estimate`, {
      items: [{ price: "team-usd", quantity: 1 }],
      coupon_ids: [code],
    });
    check(
      `signup estimate refuses ${code} with the apply's words (400)`,
      signup.status === 400 && why.test(signup.body?.error?.message ?? ""),
      j(signup.body),
    );
    const change = await call("POST", `${B}/subscriptions/${sub.publicId}/estimate`, {
      coupon_code: code,
    });
    check(
      `change estimate refuses ${code} (400)`,
      change.status === 400 && why.test(change.body?.error?.message ?? ""),
      j(change.body),
    );
    const applied = await call("POST", `${B}/subscriptions/${sub.publicId}/discount`, { code });
    check(
      `apply refuses ${code} with the same words`,
      applied.status === 400 &&
        applied.body?.error?.message === (signup.body?.error?.message ?? "-"),
      `${j(applied.body)} vs ${j(signup.body)}`,
    );
    const page = await call("POST", `${B}/checkout_sessions`, {
      price: "team-usd",
      coupons: [code],
    });
    check(`checkout page refuses ${code} (400)`, page.status === 400, j(page.body));
  }
  const fine = await call("POST", `${B}/customers/${cus.publicId}/subscription_estimate`, {
    items: [{ price: "team-usd", quantity: 1 }],
    coupon_ids: ["FINE"],
  });
  check(
    "a valid coupon still prices on the signup estimate",
    fine.status === 200 && fine.body.discount_minor === 1000,
    j(fine.body),
  );
  const fineChange = await call("POST", `${B}/subscriptions/${sub.publicId}/estimate`, {
    coupon_code: "FINE",
  });
  check("a valid coupon still prices on the change estimate", fineChange.status === 200);

  // A page minted while the code was valid keeps rendering once it expires: the code is
  // named with its refusal and left out of the figures.
  const minted = await call("POST", `${B}/checkout_sessions`, {
    price: "team-usd",
    coupons: ["FINE"],
  });
  const expire = (code: string) =>
    withTenant(orgId, (tx) =>
      tx
        .update(couponsTable)
        .set({ redeemBy: new Date(Date.now() - day) })
        .where(and(eq(couponsTable.businessId, biz.id), eq(couponsTable.code, code))),
    );
  await expire("FINE");
  const viewRes = await app.inject({
    method: "GET",
    url: "/checkout/v1/session",
    headers: { authorization: `Bearer ${minted.body.token}` },
  });
  const view = viewRes.json() as any;
  check(
    "checkout view names an expired session code with its refusal",
    viewRes.statusCode === 200 && /has expired/.test(view.coupon_refusals?.FINE ?? ""),
    j(view.coupon_refusals ?? view),
  );

  // Already attached, then expired: the next invoice still takes the discount.
  const keeper = await mkSub(biz.id, [{ price: teamUsd, quantity: 1 }]);
  await mk("KEEPER", {});
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: keeper.id,
    code: "KEEPER",
    now: new Date(),
  });
  await expire("KEEPER");
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, keeper.id)).limit(1))[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  const changePage = await call("POST", `${B}/checkout_sessions`, {
    mode: "change",
    subscription: keeper.publicId,
    items: [{ price: "team-usd", quantity: 2 }],
  });
  const changeView = (
    await app.inject({
      method: "GET",
      url: "/checkout/v1/session",
      headers: { authorization: `Bearer ${changePage.body.token}` },
    })
  ).json() as any;
  const np = changeView.nextPayment;
  check(
    "a change checkout keeps an attached, since-expired coupon in the next-payment strip",
    changePage.status === 201 &&
      np != null &&
      Number(np.subtotalMinor) === 20000 &&
      Number(np.totalMinor) === 18000 &&
      Object.keys(changeView.coupon_refusals ?? {}).length === 0,
    j({ status: changePage.status, np, refusals: changeView.coupon_refusals }),
  );
  check(
    "an attached coupon that has since expired still discounts the next invoice",
    Number(invoice.totalMinor) === 9000,
    `subtotal=${invoice.subtotalMinor} total=${invoice.totalMinor}`,
  );
}

// ── §5 coupon set rename + audit ──────────────────────────────────────────────────
{
  const set = await createCouponSet({
    organizationId: orgId,
    businessId: biz.id,
    couponId: "ONCEEACH",
    name: "Spring",
    count: 3,
  });
  const renamed = await call("PATCH", `${B}/coupon_sets/${set.set.publicId}`, {
    name: "Spring 2026",
  });
  check(
    "PATCH coupon_sets/:set renames",
    renamed.status === 200 && renamed.body.name === "Spring 2026" && renamed.body.total_count === 3,
    j(renamed.body),
  );
  const empty = await call("PATCH", `${B}/coupon_sets/${set.set.publicId}`, { name: "  " });
  check("an empty name is a 400", empty.status === 400);
  const cross = await call("PATCH", `${O}/coupon_sets/${set.set.publicId}`, { name: "x" });
  check("renaming another business's set 404s", cross.status === 404);
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(auditLogs).where(eq(auditLogs.resourceId, set.set.publicId)),
  );
  const rename = rows.find((r) => r.action === "coupon_set.rename");
  check(
    "rename writes an audit row with the name diff",
    (rename?.before as any)?.name === "Spring" && (rename?.after as any)?.name === "Spring 2026",
    j(rows.map((r) => r.action)),
  );
  check(
    "set creation is audited",
    rows.some((r) => r.action === "coupon_set.create"),
  );
}

// ── §6 comments on catalog records ────────────────────────────────────────────────
{
  const onProduct = await call("POST", `${B}/comments`, {
    resource_type: "product",
    resource_id: "team",
    body: "Raise yearly next quarter.",
  });
  const listed = await call("GET", `${B}/comments?resource_type=product&resource_id=team`);
  check(
    "comment on a product is stored and listed",
    onProduct.status === 201 && listed.body.data?.length === 1,
    j(listed.body),
  );
  for (const [type, id] of [
    ["coupon", "ONCEEACH"],
    ["product_group", "core"],
    ["price", "team-usd"],
  ] as const) {
    const r = await call("POST", `${B}/comments`, {
      resource_type: type,
      resource_id: id,
      body: "n",
    });
    check(`comment on a ${type}`, r.status === 201, j(r.body));
  }
  const cross = await call("POST", `${O}/comments`, {
    resource_type: "coupon",
    resource_id: "ONCEEACH",
    body: "n",
  });
  check("a comment on another business's coupon 404s", cross.status === 404, j(cross.body));
}

// ── §7 catalog audit rows ─────────────────────────────────────────────────────────
{
  await call("PATCH", `${B}/prices/team-usd`, { name: "Team monthly" });
  await call("PATCH", `${B}/products/team`, { name: "Team plan" });
  await call("PATCH", `${B}/product_groups/core`, { name: "Core plans" });
  const actions = async (id: string, type: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({ action: auditLogs.action, after: auditLogs.after })
          .from(auditLogs)
          .where(
            sql`${auditLogs.businessId} = ${biz.id} and ${auditLogs.resourceType} = ${type} and ${auditLogs.resourceId} = ${id}`,
          ),
      )
    ).map((r) => r.action);
  const price = await actions("team-usd", "price");
  const product = await actions("team", "product");
  const grp = await actions("core", "product_group");
  const coupon = await actions("ONCEEACH", "coupon");
  check(
    "price create + update audited",
    price.includes("price.create") && price.includes("price.update"),
    j(price),
  );
  check(
    "product create + update audited",
    product.includes("product.create") && product.includes("product.update"),
    j(product),
  );
  check(
    "product group create + update audited",
    grp.includes("product_group.create") && grp.includes("product_group.update"),
    j(grp),
  );
  check(
    "coupon create + update audited",
    coupon.includes("coupon.create") && coupon.includes("coupon.update"),
    j(coupon),
  );
  const noop = await call("PATCH", `${B}/product_groups/core`, { name: "Core plans" });
  const grpAfter = await actions("core", "product_group");
  check(
    "a no-op edit writes no audit row",
    noop.status === 200 && grpAfter.length === grp.length,
    `${grp.length} → ${grpAfter.length}`,
  );
}

await app.close();
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ CATALOG-STATS: PASS (${checks.length} checks)`
    : `\n❌ CATALOG-STATS: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
