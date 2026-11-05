/**
 * List pagination — the shared contract in `docs/GUIDE.md` §3.4, asserted for
 * every list endpoint that grows with customer volume.
 *
 * This suite exists because the contract is easy to half-implement and the
 * failure is silent in the worst way: a list that ignores `limit` ships 50k rows
 * to a browser, and one that ignores a `field[op]` filter answers with an
 * unfiltered page — a filter that doesn't filter. Both of those shipped once
 * (the customers backend was reverted while the dashboard kept calling it), so
 * every entity is checked the same way, from the service layer:
 *
 *   - `limit` is honoured and `has_more` / `next_cursor` / `total` are present
 *   - keyset pages TILE exactly into one bigger page — no gap, no repeat
 *   - a cursor survives a concurrent insert (the bug offset paging has)
 *   - `total` is the FILTERED count, and only computed for the first page — EXCEPT for
 *     resources that opt into `totalOnEveryPage` (see the option on
 *     `assertPagedContract`). Two shapes, both asserted, rather than one shape plus an
 *     undocumented divergence: a generic client needs to know which resources do what,
 *     and a contract that is quietly untrue for one endpoint is worse than one that
 *     names its exceptions.
 *   - filters actually narrow, in SQL
 *   - a stale cursor degrades to the first page, never to "no filter at all"
 *   - lists are scoped to their business
 *
 *   pnpm verify:list-pagination
 */
import { randomUUID } from "node:crypto";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createEndpoint, listDeliveriesPage } from "@/modules/webhooks/endpoints";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { webhookDeliveries } from "@db/schema";
import { runWithEventContext } from "@/platform/event-context";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { retireFixtureRetries } from "./lib/fixture-retries";
import { createCustomer, listCustomersPage } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, listSubscriptionsPage } from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  createInvoiceFromLines,
  listInvoicesPage,
} from "@/modules/invoicing/service";
import { issueAdjustmentCreditNote, listCreditNotesPage } from "@/modules/credit-notes/service";
import { recordTransaction, listTransactionsPage } from "@/modules/transactions/service";
import { listEventsUnified } from "@/modules/events/service";
import { writeAuditLog, listAuditLogsPage } from "@/modules/audit/service";
import { listEmailsPage } from "@/modules/emails/service";
// Side-effect import: registers the invoice/payment → email-outbox event sink
// (registerEventSink in emails/outbox.ts runs at module load). Without this,
// billSubscriptionPeriod below would never enqueue an email_messages row.
import "@/modules/emails/outbox";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { listGatewayWebhooksPage } from "@/modules/gateway/inbound";
import { listGatewayRequestLogsPage } from "@/modules/gateway/activity";
import { flushGatewayRequestLogs } from "@/providers/http";
import { createGatewayAccount, getGatewayAccount } from "@/modules/gateway/service";
import { resolveAdapter } from "@/providers/registry";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { and, eq, sql } from "drizzle-orm";
import {
  businesses,
  disputes,
  invoices,
  subscriptions,
  customers,
  receipts,
  paymentRequests,
} from "@db/schema";
import { listReceiptsPage } from "@/modules/receipts/service";
import { listPaymentRequestsPage } from "@/modules/payment-requests/service";
import { publicId } from "@/platform/ids";
import { listDisputesPage } from "@/modules/disputes/service";
import { listRetriesPage } from "@/modules/invoicing/retries";
import { createPaymentIntent, listPaymentIntentsPage } from "@/modules/payment-intents/service";
import type { NormalizedProviderEvent } from "@/providers/types";
import type { ListPage } from "@/platform/list-query";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const org = await createOrganization({ name: "List Pagination Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Paged Co",
  defaultCurrency: "USD",
  livemode: "test",
});
const other = await createBusiness({
  organizationId: orgId,
  name: "Other Co",
  defaultCurrency: "USD",
  livemode: "test",
});

const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

/**
 * The contract every paginated list must satisfy. `page(limit, cursor)` is the
 * service call; `idOf` pulls the row's public id.
 */
async function assertPagedContract<T>(
  label: string,
  page: (limit: number, cursor?: string) => Promise<ListPage<T>>,
  idOf: (row: T) => string,
  expectedTotal: number,
  opts?: {
    /**
     * The resource returns `total` on EVERY page, not just the first.
     *
     * Opt-in and asserted, so the exception lives in the contract instead of only in a
     * comment at the call site. Justified where the total is itself the answer the reader
     * arrived for — the ops ALERT EVIDENCE lists are the case that prompted this: the
     * total there IS the count the alert reported, so page three showing "10 of 63"
     * rather than "10 of ?" is the entire point of the drill-down. Do NOT set this to
     * paper over a resource that simply forgot to null it.
     */
    totalOnEveryPage?: boolean;
    /**
     * The resource REJECTS a malformed cursor instead of degrading to the first page.
     *
     * The contract's rule guards against a bad cursor silently WIDENING a result set
     * ("never to 'no filter at all'"), which a rejection cannot do. Justified where the
     * cursor is an opaque keyset token that only ever comes from a previous response — a
     * malformed one then means corruption or a truncated URL, and answering with page one
     * reads as a list repeating itself. NOT justified for a readable `k:<id>` cursor a
     * caller may reasonably hand-build.
     *
     * ⚠️ Only safe when the cursor DECODES AND COMPARES rather than looking the anchor row
     * up. A resource whose population is a live anti-join loses its anchor as a normal
     * SUCCESS — money getting booked — and rejecting there would fail an operator for
     * fixing the thing the alert reported.
     */
    rejectsStaleCursor?: boolean;
  },
) {
  const p1 = await page(2);
  ok(`${label}: limit is honoured`, p1.data.length === 2);
  ok(`${label}: first page carries the total`, p1.total === expectedTotal);
  ok(`${label}: has_more + cursor while rows remain`, p1.hasMore === true && !!p1.nextCursor);

  const p2 = await page(2, p1.nextCursor!);
  ok(
    opts?.totalOnEveryPage
      ? `${label}: total is carried on EVERY page (declared exception)`
      : `${label}: total is first-page only`,
    opts?.totalOnEveryPage ? p2.total === expectedTotal : p2.total === null,
  );

  const walked = [...p1.data, ...p2.data].map(idOf);
  const oneShot = (await page(4)).data.map(idOf);
  ok(`${label}: pages tile exactly into one bigger page`, walked.join() === oneShot.join());
  ok(`${label}: no row repeats across pages`, new Set(walked).size === walked.length);

  const all = await page(100);
  ok(`${label}: last page ends the walk`, all.hasMore === false && all.nextCursor === null);
  ok(`${label}: unpaginated read matches the total`, all.data.length === expectedTotal);

  if (opts?.rejectsStaleCursor) {
    // The rule is "never widens the result set". A rejection satisfies it by construction,
    // so what is asserted here is that the rejection HAPPENS — a resource claiming this
    // must not quietly accept garbage either.
    let threw = false;
    try {
      await page(2, "k:does_not_exist");
    } catch {
      threw = true;
    }
    ok(`${label}: a malformed cursor is rejected, not widened (declared exception)`, threw);
  } else {
    const stale = await page(2, "k:does_not_exist");
    ok(`${label}: a stale cursor degrades to the first page`, stale.data.length === 2);
  }
}

// ── Customers ────────────────────────────────────────────────────────────────
{
  const made = [];
  for (let i = 0; i < 5; i++) {
    made.push(
      await createCustomer({
        organizationId: orgId,
        businessId: biz.id,
        email: `pager-${i}@ex.com`,
        company: i % 2 === 0 ? "Acme" : null,
        autoCollection: i === 3 ? "off" : "on",
      }),
    );
  }
  await createCustomer({ organizationId: orgId, businessId: other.id, email: "elsewhere@ex.com" });

  await assertPagedContract(
    "customers",
    (limit, cursor) => listCustomersPage(orgId, biz.id, { limit, startingAfter: cursor }),
    (c) => c.publicId,
    5,
  );

  // A row inserted mid-walk must not shift a keyset window (offset paging would).
  const p1 = await listCustomersPage(orgId, biz.id, { limit: 2 });
  const before = await listCustomersPage(orgId, biz.id, {
    limit: 2,
    startingAfter: p1.nextCursor!,
  });
  await createCustomer({ organizationId: orgId, businessId: biz.id, email: "intruder@ex.com" });
  const after = await listCustomersPage(orgId, biz.id, { limit: 2, startingAfter: p1.nextCursor! });
  ok(
    "customers: cursor is stable across a concurrent insert",
    before.data.map((c) => c.publicId).join() === after.data.map((c) => c.publicId).join(),
  );

  const filtered = await listCustomersPage(orgId, biz.id, {
    filters: [{ field: "auto_collection", op: "is", value: "off" }],
  });
  ok("customers: a filter narrows in SQL, and total follows it", filtered.total === 1);
  const searched = await listCustomersPage(orgId, biz.id, { search: "intruder" });
  ok("customers: q searches in SQL", searched.total === 1);
  ok(
    "customers: list is scoped to its business",
    (await listCustomersPage(orgId, other.id, { limit: 100 })).total === 1,
  );
  void made;
}

// ── Subscriptions ────────────────────────────────────────────────────────────
{
  const subCustomers = [];
  for (let i = 0; i < 4; i++) {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `sub-${i}@ex.com`,
    });
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
    subCustomers.push(c);
  }

  await assertPagedContract(
    "subscriptions",
    (limit, cursor) => listSubscriptionsPage(orgId, biz.id, { limit, startingAfter: cursor }),
    (r) => r.subscription.publicId,
    4,
  );

  const page = await listSubscriptionsPage(orgId, biz.id, { limit: 2 });
  ok(
    "subscriptions: items are hydrated for the page",
    page.data.every((r) => r.items.length === 1),
  );
  ok(
    "subscriptions: a set of customer ids scopes the page (customers-list hydration)",
    (
      await listSubscriptionsPage(orgId, biz.id, {
        customerIds: [subCustomers[0]!.id, subCustomers[1]!.id],
      })
    ).total === 2,
  );
  ok(
    "subscriptions: an empty customer set matches nothing",
    (await listSubscriptionsPage(orgId, biz.id, { customerIds: [] })).total === 0,
  );
  ok(
    "subscriptions: the virtual plan filter matches by product name",
    (
      await listSubscriptionsPage(orgId, biz.id, {
        filters: [{ field: "plan", op: "contains", value: "Plan" }],
      })
    ).total === 4,
  );
  ok(
    "subscriptions: the plan filter excludes a non-matching product",
    (
      await listSubscriptionsPage(orgId, biz.id, {
        filters: [{ field: "plan", op: "is", value: "Nope" }],
      })
    ).total === 0,
  );
  ok(
    "subscriptions: status filter narrows",
    (
      await listSubscriptionsPage(orgId, biz.id, {
        filters: [{ field: "status", op: "is", value: "active" }],
      })
    ).total === 4,
  );
}

// ── Invoices ─────────────────────────────────────────────────────────────────
{
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "invoiced@ex.com",
  });
  for (let i = 0; i < 4; i++) {
    await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      currency: "USD",
      lines: [{ description: `Line ${i}`, amountMinor: BigInt(500 * (i + 1)) }],
    });
  }
  const total = (await listInvoicesPage(orgId, biz.id, { limit: 100 })).total!;
  await assertPagedContract(
    "invoices",
    (limit, cursor) => listInvoicesPage(orgId, biz.id, { limit, startingAfter: cursor }),
    (r) => r.invoice.publicId,
    total,
  );
  const mine = await listInvoicesPage(orgId, biz.id, { customerId: c.id });
  ok("invoices: customer scope narrows", mine.total === 4);
  ok(
    "invoices: amount filter narrows",
    (
      await listInvoicesPage(orgId, biz.id, {
        filters: [{ field: "total_minor", op: "gt", value: "1000" }],
      })
    ).total! < total,
  );
  ok(
    "invoices: paid totals are attached per page",
    mine.data.every((r) => typeof r.paidMinor === "bigint"),
  );
}

// ── Credit notes ─────────────────────────────────────────────────────────────
{
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "refunds@ex.com",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const notes = [];
  for (let i = 0; i < 3; i++) {
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub.subscription,
      // Non-null by construction: this fixture creates a subscription with NO trial, so it
      // starts `active` with a term. A trialling subscription has none (2026-08-25).
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    notes.push(
      // Adjustment notes work against an UNPAID invoice, which is what
      // billSubscriptionPeriod leaves behind here.
      await issueAdjustmentCreditNote({
        organizationId: orgId,
        businessId: biz.id,
        invoicePublicId: invoice.publicId,
        items: [{ description: "Goodwill", amountMinor: 100 }],
      }),
    );
  }
  const total = (await listCreditNotesPage(orgId, biz.id, { limit: 100 })).total!;
  ok("credit notes: the fixture created notes to page over", total >= 3);
  await assertPagedContract(
    "credit notes",
    (limit, cursor) => listCreditNotesPage(orgId, biz.id, { limit, startingAfter: cursor }),
    (r) => r.note.publicId,
    total,
  );
  const page = await listCreditNotesPage(orgId, biz.id, { limit: 2 });
  ok(
    "credit notes: items come back with each note (one query, not N+1)",
    page.data.every((r) => Array.isArray(r.items)),
  );
  ok(
    "credit notes: customer scope narrows",
    (await listCreditNotesPage(orgId, biz.id, { customerId: c.id })).total === total,
  );
}

// ── Transactions ─────────────────────────────────────────────────────────────
{
  const org2 = await createOrganization({ name: "Txn Pagination Org" });
  const orgId2 = org2.organization.id;
  const biz2 = await createBusiness({
    organizationId: orgId2,
    name: "Txn Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other2 = await createBusiness({
    organizationId: orgId2,
    name: "Txn Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cust2 = await createCustomer({
    organizationId: orgId2,
    businessId: biz2.id,
    email: "txn@ex.com",
  });

  const statuses: Array<"succeeded" | "failed"> = [
    "succeeded",
    "succeeded",
    "succeeded",
    "failed",
    "failed",
  ];
  for (const status of statuses) {
    await recordTransaction({
      organizationId: orgId2,
      businessId: biz2.id,
      customerId: cust2.id,
      type: "payment",
      status,
      amountMinor: 1000n,
      currency: "USD",
      gatewayKey: "tmtest",
    });
  }
  await recordTransaction({
    organizationId: orgId2,
    businessId: other2.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 500n,
    currency: "USD",
    gatewayKey: "tmtest",
  });

  await assertPagedContract(
    "transactions",
    (limit, cursor) => listTransactionsPage(orgId2, biz2.id, { limit, startingAfter: cursor }),
    (r) => r.txn.publicId,
    5,
  );

  const failed = await listTransactionsPage(orgId2, biz2.id, {
    filters: [{ field: "status", op: "is", value: "failed" }],
  });
  ok("transactions: a filter narrows in SQL", failed.total === 2);
  ok(
    "transactions: list is scoped to its business",
    (await listTransactionsPage(orgId2, other2.id, { limit: 100 })).total === 1,
  );
}

// ── Customer name: what the list shows, and what the filter matches ──────────
//
// Every operator list resolves its Customer column through `accountHolderName`
// (`modules/customers/names.ts`) and filters `customer_name` through the SQL
// mirror of the same chain (`modules/customers/name-sql.ts`). Both halves are
// asserted together because each one hides the other: a blank column looks like
// a customer with no name, and an empty filtered page looks like a customer with
// no invoices. Before this, both read our legacy `customers.name` column — which
// the API never populates — so a customer created with first/last was nameless on
// screen AND unfindable by the name the operator was reading off it.
{
  const org3 = await createOrganization({ name: "Name Resolution Org" });
  const orgId3 = org3.organization.id;
  const biz3 = await createBusiness({
    organizationId: orgId3,
    name: "Named Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const product3 = await createProduct({
    organizationId: orgId3,
    businessId: biz3.id,
    name: "Named Plan",
  });
  const price3 = await createPrice({
    organizationId: orgId3,
    businessId: biz3.id,
    productId: product3.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });

  // One customer per rung of the chain. There used to be a fourth rung here — a row
  // with only the legacy `customers.name` — but that column is deprecated and out of
  // the chain (2026-08-23), so first+last → company → email is the whole ladder.
  const structured = await createCustomer({
    organizationId: orgId3,
    businessId: biz3.id,
    email: "priya@ex.com",
    firstName: "Priya",
    lastName: "Raghunathan",
  });
  const companyOnly = await createCustomer({
    organizationId: orgId3,
    businessId: biz3.id,
    email: "ap@kavi.example",
    company: "Kavi Analytics Pvt Ltd",
  });
  const nameless = await createCustomer({
    organizationId: orgId3,
    businessId: biz3.id,
    email: "nameless@ex.com",
  });
  // A row carrying ONLY the deprecated `customers.name`. The service cannot produce
  // one any more (2026-08-23) and the API 400s on the field, so it is written straight
  // to the column — which is exactly the state real rows are in after the deprecation.
  // Both the rendered column and the filter must ignore it.
  const legacy = await createCustomer({
    organizationId: orgId3,
    businessId: biz3.id,
    email: "legacy@ex.com",
  });
  await withTenant(orgId3, (tx) =>
    tx.update(customers).set({ name: "Legacy Import Name" }).where(eq(customers.id, legacy.id)),
  );

  let structuredInvoice = "";
  for (const c of [structured, companyOnly, nameless, legacy]) {
    const inv = await createInvoiceFromLines({
      organizationId: orgId3,
      businessId: biz3.id,
      customerId: c.id,
      currency: "USD",
      lines: [{ description: "Line", amountMinor: 1000n }],
    });
    if (c.id === structured.id) structuredInvoice = inv.invoice.publicId;
  }
  await createSubscription({
    organizationId: orgId3,
    businessId: biz3.id,
    customerId: structured.id,
    now: new Date(),
    items: [{ price: price3, quantity: 1 }],
  });

  const invRows = await listInvoicesPage(orgId3, biz3.id, { limit: 100 });
  const shownFor = (pid: string) =>
    invRows.data.find((r) => r.customerPublicId === pid)?.customerName;
  ok(
    "invoices: the Customer column resolves first+last",
    shownFor(structured.publicId) === "Priya Raghunathan",
  );
  ok(
    "invoices: the Customer column falls back to the company",
    shownFor(companyOnly.publicId) === "Kavi Analytics Pvt Ltd",
  );
  ok(
    "invoices: a row with no name at all shows the email, not a blank",
    shownFor(nameless.publicId) === "nameless@ex.com",
  );
  ok(
    "invoices: a legacy-only row shows its EMAIL — the deprecated name column is not read",
    shownFor(legacy.publicId) === "legacy@ex.com",
  );

  const nameFilter = (value: string, op = "contains") =>
    listInvoicesPage(orgId3, biz3.id, { filters: [{ field: "customer_name", op, value }] });
  ok(
    "invoices: customer_name finds a customer who has ONLY first/last",
    (await nameFilter("raghunathan")).total === 1,
  );
  ok(
    "invoices: customer_name matches the `first last` form the list displays",
    (await nameFilter("priya raghunathan")).total === 1,
  );
  ok(
    "invoices: customer_name[is] compares against the resolved name",
    (await nameFilter("Priya Raghunathan", "is")).total === 1,
  );
  ok("invoices: customer_name reaches the company", (await nameFilter("kavi")).total === 1);
  // The deprecation, pinned from the predicate side too. If `customers.name` ever
  // creeps back into `accountHolderNameSql` alone, the list would show 'legacy@ex.com'
  // while the filter matched on 'Legacy Import Name' — the screen-vs-filter split this
  // whole block exists to prevent, just in the opposite direction.
  ok(
    "invoices: customer_name does NOT reach the deprecated name column",
    (await nameFilter("Legacy Import")).total === 0,
  );
  // The one asymmetry, pinned on purpose: the display falls through to the email,
  // the predicate does not (see `name-sql.ts` — `customer_email` is its own field,
  // and folding the email in would make "has no name" true for every row).
  //
  // TWO rows now, not one: `nameless` and `legacy`. That is the deprecation stated as
  // an assertion — a row whose only name is the dead `customers.name` column HAS no
  // name, and "show me customers missing a name" is finally allowed to say so instead
  // of hiding them behind a column no form could edit.
  ok(
    "invoices: customer_name[is_present]=false counts the legacy-only row as nameless",
    (await nameFilter("false", "is_present")).total === 2,
  );
  ok(
    "subscriptions: customer_name resolves the same way as on invoices",
    (
      await listSubscriptionsPage(orgId3, biz3.id, {
        filters: [{ field: "customer_name", op: "contains", value: "priya raghunathan" }],
      })
    ).total === 1,
  );
  const subRow = (await listSubscriptionsPage(orgId3, biz3.id, { limit: 1 })).data[0];
  ok(
    "subscriptions: the list row carries the resolved name",
    subRow?.customerName === "Priya Raghunathan",
  );

  // The other two lists that denormalise a name server-side, so the dashboard
  // cannot repair it client-side: the money log and the credit-notes index.
  await recordTransaction({
    organizationId: orgId3,
    businessId: biz3.id,
    customerId: structured.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 1000n,
    currency: "USD",
    gatewayKey: "tmtest",
  });
  const txnRow = (await listTransactionsPage(orgId3, biz3.id, { limit: 1 })).data[0];
  ok(
    "transactions: the money log names the payer from first+last",
    txnRow?.customerName === "Priya Raghunathan",
  );

  await issueAdjustmentCreditNote({
    organizationId: orgId3,
    businessId: biz3.id,
    invoicePublicId: structuredInvoice,
    items: [{ description: "Goodwill", amountMinor: 100 }],
  });
  const cnRow = (await listCreditNotesPage(orgId3, biz3.id, { limit: 1 })).data[0];
  ok(
    "credit notes: the list row names the payer from first+last",
    cnRow?.customerName === "Priya Raghunathan",
  );
}

// ── Events ───────────────────────────────────────────────────────────────────
// `listEventsUnified` (src/modules/events/service.ts) now satisfies the same
// `ListPage<T>` contract as every other resource — the two defects this suite
// used to report are FIXED (docs/PROGRESS.md, 2026-08-01):
//  1. The seek stays on the raw indexed column (cursor cast back `::timestamptz`
//     inside SQL, via the shared `keysetCondition`), and the native+imported
//     merge sorts on a projected microsecond-precision STRING key instead of a
//     ms-truncated JS `Date` — so same-timestamp rows (a bulk import, or one
//     transaction emitting several events) no longer fall through the gap.
//  2. `total` is computed across BOTH tables on the first page.
// Wired into `assertPagedContract` like the other nine resources.
{
  const org3 = await createOrganization({ name: "Events Pagination Org" });
  const orgId3 = org3.organization.id;
  const biz3 = await createBusiness({
    organizationId: orgId3,
    name: "Events Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other3 = await createBusiness({
    organizationId: orgId3,
    name: "Events Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  const product3 = await createProduct({
    organizationId: orgId3,
    businessId: biz3.id,
    name: "Plan3",
  });
  const price3 = await createPrice({
    organizationId: orgId3,
    businessId: biz3.id,
    productId: product3.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const evCustomers = [];
  for (let i = 0; i < 5; i++) {
    evCustomers.push(
      await createCustomer({
        organizationId: orgId3,
        businessId: biz3.id,
        email: `ev-${i}@ex.com`,
      }),
    );
  }
  // A different event type (subscription_created, +started/+activated) so the
  // type filter below has something real to exclude — AND, critically, three
  // events sharing the exact same microsecond-precision timestamp, since
  // createSubscription emits all three in ONE transaction. That shared instant
  // is exactly what used to defeat the ms-truncated merge/cursor.
  await createSubscription({
    organizationId: orgId3,
    businessId: biz3.id,
    customerId: evCustomers[0]!.id,
    now: new Date(),
    items: [{ price: price3, quantity: 1 }],
  });
  // Baseline BEFORE anything of ours lands on `other3` (createBusiness itself
  // emits e.g. `gateway_account_created` — counting from a fixed literal would
  // be guessing at business-creation internals that aren't this test's concern).
  const otherBaseline = (await listEventsUnified(orgId3, { businessId: other3.id, limit: 100 }))
    .data.length;
  await createCustomer({ organizationId: orgId3, businessId: other3.id, email: "ev-other@ex.com" });

  const total3 = (await listEventsUnified(orgId3, { businessId: biz3.id, limit: 100 })).total!;
  ok("events: the fixture created rows to page over", total3 >= 6);

  await assertPagedContract(
    "events",
    (limit, cursor) =>
      listEventsUnified(orgId3, { businessId: biz3.id, limit, startingAfter: cursor }),
    (r) => r.row.publicId,
    total3,
  );

  const custType = await listEventsUnified(orgId3, {
    businessId: biz3.id,
    types: ["customer_created"],
  });
  ok("events: a type filter narrows in SQL", custType.data.length === 5);
  const subType = await listEventsUnified(orgId3, {
    businessId: biz3.id,
    types: ["subscription_created"],
  });
  ok("events: the type filter excludes non-matching types", subType.data.length === 1);

  const all = await listEventsUnified(orgId3, { businessId: biz3.id, limit: 100 });
  const bizIds = new Set(all.data.map((r) => r.row.publicId));
  const otherAfter = await listEventsUnified(orgId3, { businessId: other3.id, limit: 100 });
  ok("events: list is scoped to its business", otherAfter.data.length === otherBaseline + 1);
  ok(
    "events: business scope excludes the other business's rows",
    otherAfter.data.every((r) => !bizIds.has(r.row.publicId)),
  );
}

// ── Audit logs ───────────────────────────────────────────────────────────────
{
  const org4 = await createOrganization({ name: "Audit Pagination Org" });
  const orgId4 = org4.organization.id;
  const biz4 = await createBusiness({
    organizationId: orgId4,
    name: "Audit Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other4 = await createBusiness({
    organizationId: orgId4,
    name: "Audit Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  const actions = [
    "resource.alpha",
    "resource.alpha",
    "resource.beta",
    "resource.beta",
    "resource.beta",
  ];
  for (const action of actions) {
    await writeAuditLog({
      organizationId: orgId4,
      businessId: biz4.id,
      action,
      resourceType: "test",
      resourceId: "r1",
      actor: "key_admin",
      source: "api",
    });
  }
  await writeAuditLog({
    organizationId: orgId4,
    businessId: other4.id,
    action: "resource.alpha",
    resourceType: "test",
    resourceId: "r2",
  });

  // REAL FINDING: audit rows have no public id — the keyset tiebreak is the raw
  // uuid PK (`auditLogs.id`). `assertPagedContract`'s stale-cursor probe sends the
  // non-existent-but-plausible cursor `k:does_not_exist`; for every other resource
  // here the tiebreak is a text public id, so a not-found lookup degrades cleanly
  // to page one. For audit logs, `listAuditLogsPage` (src/modules/audit/service.ts)
  // feeds that same raw string into `eq(auditLogs.id, keysetId)` against a `uuid`
  // column with NO validation, and Postgres throws `22P02 invalid input syntax for
  // type uuid` — an uncaught 500, not a graceful degrade-to-first-page. That is
  // exactly the failure mode this suite's contract forbids ("a stale cursor
  // degrades to the first page, never crashes"). Caught here so the rest of the
  // suite can still run; left FAILING on purpose — not fixed (src/ is out of scope
  // for this task) and not fudged.
  try {
    await assertPagedContract(
      "audit logs",
      (limit, cursor) =>
        listAuditLogsPage(orgId4, { businessId: biz4.id, limit, startingAfter: cursor }),
      (r) => r.id,
      5,
    );
  } catch (e) {
    ok(
      `audit logs: a stale cursor degrades to the first page [FINDING: listAuditLogsPage throws instead — ${e instanceof Error ? e.message : String(e)}]`,
      false,
    );
  }

  const narrowed = await listAuditLogsPage(orgId4, {
    businessId: biz4.id,
    filters: [{ field: "action", op: "is", value: "resource.beta" }],
  });
  ok("audit logs: a filter narrows in SQL", narrowed.total === 3);
  ok(
    "audit logs: list is scoped to its business",
    (await listAuditLogsPage(orgId4, { businessId: other4.id, limit: 100 })).total === 1,
  );
}

// ── Emails ───────────────────────────────────────────────────────────────────
{
  const org5 = await createOrganization({ name: "Emails Pagination Org" });
  const orgId5 = org5.organization.id;
  const biz5 = await createBusiness({
    organizationId: orgId5,
    name: "Emails Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other5 = await createBusiness({
    organizationId: orgId5,
    name: "Emails Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  async function setupEmailBiz(bizId: string, tag: string, cycles: number) {
    await withTenant(orgId5, (tx) =>
      tx
        .update(businesses)
        .set({ emailConfig: { enabled: true } })
        .where(eq(businesses.id, bizId)),
    );
    const customer = await createCustomer({
      organizationId: orgId5,
      businessId: bizId,
      email: `payer-${tag}@ex.com`,
      firstName: "Pat",
      lastName: "Payer",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId5,
      businessId: bizId,
      customer,
      token: "tok_4242",
    });
    const product = await createProduct({ organizationId: orgId5, businessId: bizId, name: "Pro" });
    const price = await createPrice({
      organizationId: orgId5,
      businessId: bizId,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 5000,
      interval: "month",
    });
    const sub = await createSubscription({
      organizationId: orgId5,
      businessId: bizId,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    });
    for (let i = 0; i < cycles; i++) {
      await billSubscriptionPeriod({
        organizationId: orgId5,
        businessId: bizId,
        subscription: sub.subscription,
        // Non-null by construction: this fixture creates a subscription with NO trial, so it
        // starts `active` with a term. A trialling subscription has none (2026-08-25).
        periodStart: sub.subscription.currentPeriodStart!,
        periodEnd: sub.subscription.currentPeriodEnd!,
      });
    }
  }

  // 3 paid billing cycles → invoice_issued + payment_receipt per cycle.
  await setupEmailBiz(biz5.id, "main", 3);
  // A second business, scoped separately, with its own (smaller) cycle count.
  await setupEmailBiz(other5.id, "other", 1);

  const total5 = (await listEmailsPage(orgId5, biz5.id, { limit: 100 })).total!;
  ok("emails: the fixture created rows to page over", total5 >= 5);
  await assertPagedContract(
    "emails",
    (limit, cursor) => listEmailsPage(orgId5, biz5.id, { limit, startingAfter: cursor }),
    (r) => r.publicId,
    total5,
  );

  const receipts = await listEmailsPage(orgId5, biz5.id, {
    filters: [{ field: "type", op: "is", value: "payment_receipt" }],
  });
  ok("emails: a filter narrows in SQL", receipts.total === 3);
  // One paid cycle enqueues invoice_issued + payment_receipt, and activating the
  // subscription enqueues subscription_activated once — so a `cycles`-cycle business
  // holds `1 + 2 * cycles`. Derived rather than written as a literal: this assertion
  // read `=== 2` and had been FAILING since subscription_activated was added, because
  // a magic number cannot say which of its parts changed. The exact count is still
  // asserted (not just "fewer than the other business"), since that is what catches a
  // scope leak — a leak here would read 7, not 4.
  const emailsForCycles = (cycles: number) => 1 + 2 * cycles;
  ok(
    "emails: list is scoped to its business",
    (await listEmailsPage(orgId5, other5.id, { limit: 100 })).total === emailsForCycles(1),
  );
}

// ── Gateway webhooks (inbound) ───────────────────────────────────────────────
{
  const org6 = await createOrganization({ name: "GW Webhooks Pagination Org" });
  const orgId6 = org6.organization.id;
  const biz6 = await createBusiness({
    organizationId: orgId6,
    name: "GW Webhooks Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other6 = await createBusiness({
    organizationId: orgId6,
    name: "GW Webhooks Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  const types: Array<NormalizedProviderEvent["type"]> = [
    "charge.succeeded",
    "charge.succeeded",
    "charge.succeeded",
    "charge.failed",
    "charge.failed",
  ];
  let n = 0;
  for (const type of types) {
    n++;
    const ev: NormalizedProviderEvent = {
      providerEventId: `evt_pgn_${orgId6}_${n}`,
      type,
      providerChargeId: `ch_pgn_${n}`,
      occurredAt: new Date(),
      raw: {},
    };
    await handleProviderEvent("tmtest", ev, { businessId: biz6.id, payload: { n } });
  }
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `evt_pgn_${orgId6}_other`,
      type: "charge.succeeded",
      providerChargeId: "ch_pgn_other",
      occurredAt: new Date(),
      raw: {},
    },
    { businessId: other6.id, payload: {} },
  );

  // REAL FINDING: same class of bug as audit_logs above. `provider_events` has no
  // public id — the keyset tiebreak is the raw uuid PK. `assertPagedContract`'s
  // stale-cursor probe (`k:does_not_exist`) reaches `listGatewayWebhooksPage`
  // (src/modules/gateway/inbound.ts), which feeds it straight into
  // `eq(providerEvents.id, keysetId)` against a `uuid` column with no format
  // guard — Postgres throws `22P02 invalid input syntax for type uuid` instead of
  // degrading to the first page. Caught here so the rest of the suite still runs;
  // left FAILING on purpose.
  try {
    await assertPagedContract(
      "gateway webhooks",
      (limit, cursor) => listGatewayWebhooksPage(orgId6, biz6.id, { limit, startingAfter: cursor }),
      (r) => r.id,
      5,
    );
  } catch (e) {
    ok(
      `gateway webhooks: a stale cursor degrades to the first page [FINDING: listGatewayWebhooksPage throws instead — ${e instanceof Error ? e.message : String(e)}]`,
      false,
    );
  }

  const failedOnly = await listGatewayWebhooksPage(orgId6, biz6.id, {
    filters: [{ field: "type", op: "is", value: "charge.failed" }],
  });
  ok("gateway webhooks: a filter narrows in SQL", failedOnly.total === 2);
  ok(
    "gateway webhooks: list is scoped to its business",
    (await listGatewayWebhooksPage(orgId6, other6.id, { limit: 100 })).total === 1,
  );
}

// ── Gateway requests (outbound) ──────────────────────────────────────────────
{
  const org7 = await createOrganization({ name: "GW Requests Pagination Org" });
  const orgId7 = org7.organization.id;
  const biz7 = await createBusiness({
    organizationId: orgId7,
    name: "GW Requests Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other7 = await createBusiness({
    organizationId: orgId7,
    name: "GW Requests Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  const acct7 = await createGatewayAccount({
    organizationId: orgId7,
    businessId: biz7.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const acctRow7 = (await getGatewayAccount(orgId7, biz7.id, acct7.publicId))!;
  const tm7 = resolveAdapter(acctRow7);
  const cust7 = await createCustomer({
    organizationId: orgId7,
    businessId: biz7.id,
    email: "gwreq@ex.com",
  });

  // ensure_customer(1) + vault(1) + charge(2) + refund(2) = 6 outbound log rows.
  await runWithEventContext({ source: "system", actor: "verify-list-pagination" }, async () => {
    const ref = await tm7.ensureCustomer({ customerRef: cust7.publicId });
    const pmRef = await tm7.vaultPaymentMethod({
      customer: ref,
      token: "tok_tmtest_4242424242424242",
    });
    for (let i = 0; i < 2; i++) {
      const chargeRes = await tm7.charge({
        amountMinor: 1000n,
        currency: "USD",
        customer: ref,
        paymentMethod: pmRef,
        idempotencyKey: `idem_gwreq_${i}_${Date.now()}`,
      });
      await tm7.refund({
        providerChargeId: chargeRes.providerChargeId,
        amountMinor: 1000n,
        idempotencyKey: `idem_gwreq_refund_${i}_${Date.now()}`,
      });
    }
  });

  // A cross-business row so the scope assertion below has something to exclude.
  const acctOther7 = await createGatewayAccount({
    organizationId: orgId7,
    businessId: other7.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const acctOtherRow7 = (await getGatewayAccount(orgId7, other7.id, acctOther7.publicId))!;
  const tmOther7 = resolveAdapter(acctOtherRow7);
  const custOther7 = await createCustomer({
    organizationId: orgId7,
    businessId: other7.id,
    email: "gwreq-other@ex.com",
  });
  await runWithEventContext({ source: "system", actor: "verify-list-pagination" }, async () => {
    await tmOther7.ensureCustomer({ customerRef: custOther7.publicId });
  });

  // Same fire-and-forget race as `verify:gateway-activity`: the seeding loop's log rows
  // are inserted without being awaited, so counting them immediately can undercount.
  await flushGatewayRequestLogs();
  const total7 = (await listGatewayRequestLogsPage(orgId7, biz7.id, { limit: 100 })).total!;
  ok("gateway requests: the fixture created rows to page over", total7 >= 5);
  // REAL FINDING: same class of bug as audit_logs / gateway_webhooks above.
  // `gateway_request_logs` has no public id — the keyset tiebreak is the raw
  // uuid PK. `assertPagedContract`'s stale-cursor probe (`k:does_not_exist`)
  // reaches `listGatewayRequestLogsPage` (src/modules/gateway/activity.ts), which
  // feeds it straight into `eq(gatewayRequestLogs.id, keysetId)` against a `uuid`
  // column with no format guard — Postgres throws `22P02 invalid input syntax for
  // type uuid` instead of degrading to the first page. Caught here so the rest of
  // the suite still runs; left FAILING on purpose.
  try {
    await assertPagedContract(
      "gateway requests",
      (limit, cursor) =>
        listGatewayRequestLogsPage(orgId7, biz7.id, { limit, startingAfter: cursor }),
      (r) => r.id,
      total7,
    );
  } catch (e) {
    ok(
      `gateway requests: a stale cursor degrades to the first page [FINDING: listGatewayRequestLogsPage throws instead — ${e instanceof Error ? e.message : String(e)}]`,
      false,
    );
  }

  const chargeOnly = await listGatewayRequestLogsPage(orgId7, biz7.id, {
    filters: [{ field: "operation", op: "is", value: "charge" }],
  });
  ok("gateway requests: a filter narrows in SQL", chargeOnly.total === 2);
  ok(
    "gateway requests: list is scoped to its business",
    (await listGatewayRequestLogsPage(orgId7, other7.id, { limit: 100 })).total === 1,
  );
}

// ── Payment intents ──────────────────────────────────────────────────────────
//
// Added 2026-09-09. Its contract was already correct — `PagedList`, a real `count(*)`, the
// page wiring `has_more`/`next_cursor` — so this is COVERAGE, not a fix. It was simply absent
// from the suite, which the `ui` skill's own rule says is enough to assume the contract is
// unverified: "a list not in that gate can regress silently".
{
  const orgP = await createOrganization({ name: "Intents Pagination Org" });
  const orgIdP = orgP.organization.id;
  const bizP = await createBusiness({
    organizationId: orgIdP,
    name: "Intents Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const otherP = await createBusiness({
    organizationId: orgIdP,
    name: "Intents Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // An intent ROUTES to a gateway account, so each business needs one that handles USD.
  const seedIntents = async (businessId: string, tag: string, n: number) => {
    await createGatewayAccount({
      organizationId: orgIdP,
      businessId,
      gatewayKey: "tmtest",
      label: `TM Test ${tag}`,
      credentials: {},
    });
    const customer = await createCustomer({
      organizationId: orgIdP,
      businessId,
      email: `intent-${tag}@ex.com`,
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgIdP,
      businessId,
      customer,
      token: "tok_tmtest_4242424242424242",
    });
    // `runWithEventContext` because creating an intent emits events and talks to the adapter,
    // exactly as the gateway-requests section above does for its outbound calls.
    await runWithEventContext({ source: "system", actor: "verify-list-pagination" }, async () => {
      for (let i = 0; i < n; i++) {
        await createPaymentIntent({
          organizationId: orgIdP,
          businessId,
          paymentMethodPublicId: pm.publicId,
          amountMinor: 1000 + i,
          currency: "USD",
        });
      }
    });
  };
  await seedIntents(bizP.id, "main", 5);
  await seedIntents(otherP.id, "other", 1);

  await assertPagedContract(
    "payment intents",
    (limit, cursor) => listPaymentIntentsPage(orgIdP, bizP.id, { limit, startingAfter: cursor }),
    (r) => r.intent.publicId,
    5,
  );
  ok(
    "payment intents: a purpose filter narrows in SQL",
    (await listPaymentIntentsPage(orgIdP, bizP.id, { purpose: "setup", limit: 100 })).total === 0,
  );
  ok(
    "payment intents: list is scoped to its business",
    (await listPaymentIntentsPage(orgIdP, otherP.id, { limit: 100 })).total === 1,
  );
}

/**
 * The retries block plants `payment_due` invoices with a live `next_attempt_at`, which is
 * exactly what `due_work` calls a dunning retry — so unlike the far-future rows this suite
 * purges directly, these are REAL work the diary is right to hold, and they never age out.
 * Retired at the end instead.
 */
const retriesOrgs: string[] = [];

// ── Retries (invoices under retry) ───────────────────────────────────────────
//
// Added 2026-09-09 together with the fix it forces. `listRetriesPage` computed `count(*)`
// unconditionally, so it answered with `total` on EVERY page — an undeclared deviation the
// contract allows only as an explicit `totalOnEveryPage`. It was never caught because retries
// was not in this suite. Not a justified exception either: `ListPage`'s `loadMore` never calls
// `setTotal`, so the count after page one was discarded by the only consumer. Now nulled, and
// asserted here WITHOUT the flag.
{
  const orgR = await createOrganization({ name: "Retries Pagination Org" });
  const orgIdR = orgR.organization.id;
  retriesOrgs.push(orgIdR);
  const bizR = await createBusiness({
    organizationId: orgIdR,
    name: "Retries Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const otherR = await createBusiness({
    organizationId: orgIdR,
    name: "Retries Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const custR = await createCustomer({
    organizationId: orgIdR,
    businessId: bizR.id,
    email: "retry@ex.com",
  });
  const custOtherR = await createCustomer({
    organizationId: orgIdR,
    businessId: otherR.id,
    email: "retry-other@ex.com",
  });

  /**
   * Put an invoice into `UNDER_RETRY` by hand. The predicate is
   * `(status in (payment_due,not_paid) and (attempt_count > 0 or next_attempt_at is not null))
   *  or (dunning_status is not null and status <> 'voided')`, and driving the real dunning pass
   * would make this a dunning test rather than a pagination one.
   *
   * `next_attempt_at` is DISTINCT per row because that column is the sort key (ascending,
   * with the public id as tiebreak) — ties would still page correctly, but a pagination test
   * should not depend on it.
   */
  const putUnderRetry = async (
    organizationId: string,
    businessId: string,
    customerId: string,
    i: number,
  ) => {
    const inv = await createInvoiceFromLines({
      organizationId,
      businessId,
      customerId,
      currency: "USD",
      lines: [{ description: `Retry line ${i}`, amountMinor: BigInt(1000 + i) }],
    });
    await withTenant(organizationId, (tx) =>
      tx
        .update(invoices)
        .set({
          status: "payment_due",
          attemptCount: 1,
          nextAttemptAt: new Date(Date.now() + (i + 1) * 3_600_000),
          dunningStatus: "in_progress",
        })
        .where(eq(invoices.id, inv.invoice.id)),
    );
    return inv.invoice;
  };

  for (let i = 0; i < 5; i++) await putUnderRetry(orgIdR, bizR.id, custR.id, i);
  await putUnderRetry(orgIdR, otherR.id, custOtherR.id, 9);
  // A plain unpaid invoice with no attempt and no schedule is NOT under retry — the predicate
  // exists because voided-and-recreated dunning rows used to reappear here.
  await createInvoiceFromLines({
    organizationId: orgIdR,
    businessId: bizR.id,
    customerId: custR.id,
    currency: "USD",
    lines: [{ description: "Not under retry", amountMinor: 700n }],
  });

  await assertPagedContract(
    "retries",
    (limit, cursor) => listRetriesPage(orgIdR, bizR.id, { limit, startingAfter: cursor }),
    (r) => r.invoice.publicId,
    5,
  );
  ok(
    "retries: an invoice with no attempt and no schedule is excluded",
    (await listRetriesPage(orgIdR, bizR.id, { limit: 100 })).total === 5,
  );
  ok(
    "retries: list is scoped to its business",
    (await listRetriesPage(orgIdR, otherR.id, { limit: 100 })).total === 1,
  );
}

// ── Disputes ─────────────────────────────────────────────────────────────────
//
// Added 2026-09-09, with the endpoint that made it possible. `listDisputes` returned a bare
// array capped at `min(limit ?? 50, 200)` — no `has_more`, so a business past fifty chargebacks
// could not reach the rest and no caller could tell. Same defect as `listGatewayRequests`
// (61 of 111 rows hidden), and it is exactly what this suite exists to catch: the list was
// simply never in it.
//
// Rows are inserted directly rather than driven through `handleDisputeEvent`: this asserts the
// READ contract, and the write path needs a correlated charge whose absence would test nothing
// here. `verify-disputes` owns the webhook pipeline.
{
  const orgD = await createOrganization({ name: "Disputes Pagination Org" });
  const orgIdD = orgD.organization.id;
  const bizD = await createBusiness({
    organizationId: orgIdD,
    name: "Disputes Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const otherD = await createBusiness({
    organizationId: orgIdD,
    name: "Disputes Other Co",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // Distinct `created_at` per row so the keyset order is deterministic. The tiebreak would
  // cope with ties — and `keysetCondition`'s microsecond handling is what makes that true —
  // but a pagination test should not depend on rows landing in separate milliseconds.
  const base = Date.now() - 60_000;
  const seedDispute = async (businessId: string, i: number, status: "needs_response" | "won") => {
    await withTenant(orgIdD, (tx) =>
      tx.insert(disputes).values({
        publicId: publicId("dsp"),
        organizationId: orgIdD,
        businessId,
        providerKey: "tmtest",
        providerDisputeId: `dp_pag_${businessId.slice(0, 8)}_${i}`,
        status,
        amountMinor: 1000n,
        currency: "USD",
        createdAt: new Date(base + i * 1000),
        openedAt: new Date(base + i * 1000),
      }),
    );
  };
  // 3 needs_response + 2 won = 5 in the business under test, 1 in its sibling.
  for (let i = 0; i < 3; i++) await seedDispute(bizD.id, i, "needs_response");
  for (let i = 3; i < 5; i++) await seedDispute(bizD.id, i, "won");
  await seedDispute(otherD.id, 9, "needs_response");

  await assertPagedContract(
    "disputes",
    (limit, cursor) => listDisputesPage(orgIdD, bizD.id, { limit, startingAfter: cursor }),
    (r) => r.publicId,
    5,
  );

  const needsResponse = await listDisputesPage(orgIdD, bizD.id, { status: "needs_response" });
  ok("disputes: a status filter narrows in SQL", needsResponse.total === 3);
  ok(
    "disputes: list is scoped to its business",
    (await listDisputesPage(orgIdD, otherD.id, { limit: 100 })).total === 1,
  );

  // `open=true` + `sort=evidence_due_by` — the "next deadline" read. Own business, so the
  // counts above stay put.
  const deadlineD = await createBusiness({
    organizationId: orgIdD,
    name: "Disputes Deadline Co",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const day = 86_400_000;
  const due = [
    ["needs_response", 3],
    ["under_review", 1],
    ["needs_response", null],
    ["won", 2],
  ] as const;
  const ids: string[] = [];
  for (const [i, [status, inDays]] of due.entries()) {
    const id = publicId("dsp");
    ids.push(id);
    await withTenant(orgIdD, (tx) =>
      tx.insert(disputes).values({
        publicId: id,
        organizationId: orgIdD,
        businessId: deadlineD.id,
        providerKey: "tmtest",
        providerDisputeId: `dp_due_${deadlineD.id.slice(0, 8)}_${i}`,
        status,
        amountMinor: 1000n,
        currency: "USD",
        evidenceDueBy: inDays == null ? null : new Date(Date.now() + inDays * day),
        createdAt: new Date(base + i * 1000),
        openedAt: new Date(base + i * 1000),
      }),
    );
  }
  const openByDeadline = await listDisputesPage(orgIdD, deadlineD.id, {
    open: true,
    sort: "evidence_due_by",
  });
  ok(
    "disputes: open=true keeps only disputes awaiting a decision",
    openByDeadline.total === 3 && openByDeadline.data.every((r) => r.status !== "won"),
  );
  ok(
    "disputes: sort=evidence_due_by puts the soonest deadline first and none last",
    openByDeadline.data.map((r) => r.publicId).join() === [ids[1], ids[0], ids[2]].join(),
  );
  await assertPagedContract(
    "disputes by deadline",
    (limit, cursor) =>
      listDisputesPage(orgIdD, deadlineD.id, {
        sort: "evidence_due_by",
        limit,
        startingAfter: cursor,
      }),
    (r) => r.publicId,
    4,
  );
}

// ── The shared query grammar, over HTTP (`parseListQuery` + `listResponse`) ──────
//
// JSON-array set values, unix-second dates, `offset`/`next_offset` and `include_deleted`
// all live in the route layer, so they are asserted through `app.inject`, next to the
// forms that already worked — each of which must answer exactly as before.
{
  const { buildApp } = await import("@/index");
  const { createApiKey } = await import("@/modules/tenancy/service");
  const { businessTimezone } = await import("@/platform/business-tz");
  const app = await buildApp({ logger: false });
  const key = await createApiKey(orgId, "test");
  type Row = { id: string; status?: string; deleted?: boolean };
  type Body = {
    data: Row[];
    has_more: boolean;
    next_cursor: string | null;
    next_offset?: string;
    total: number | null;
  };
  const get = async (path: string) => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/${path}`,
      headers: { authorization: `Bearer ${key.secret}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as Body };
  };
  const enc = encodeURIComponent;
  const ids = (b: Body) => b.data.map((r) => r.id).join();

  const all = (await get("invoices?limit=100")).body;
  const [i1, i2] = all.data;
  ok("grammar: the fixture has invoices to filter", all.data.length >= 4 && !!i1 && !!i2);

  // ── Set values: the comma form is unchanged, the JSON form answers identically.
  const comma = await get(`invoices?limit=100&id[in]=${enc(`${i1!.id},${i2!.id}`)}`);
  const json = await get(`invoices?limit=100&id[in]=${enc(JSON.stringify([i1!.id, i2!.id]))}`);
  ok("grammar: comma-form set still narrows to its members", comma.body.total === 2);
  ok(
    "grammar: JSON-array set returns the same rows as the comma form",
    json.status === 200 && ids(json.body) === ids(comma.body),
  );
  const notIn = await get(`invoices?limit=100&id[not_in]=${enc(JSON.stringify([i1!.id]))}`);
  ok("grammar: JSON-array not_in excludes its member", notIn.body.total === (all.total ?? 0) - 1);
  const statuses = [...new Set(all.data.map((r) => r.status!))];
  const byComma = await get(`invoices?limit=100&status[in]=${enc(statuses.join(","))}`);
  const byJson = await get(`invoices?limit=100&status[in]=${enc(JSON.stringify(statuses))}`);
  ok(
    "grammar: enum set, comma vs JSON, same rows",
    byComma.body.total === all.total && ids(byJson.body) === ids(byComma.body),
  );
  const rangeComma = await get("invoices?limit=100&total_minor[between]=500,1000");
  const rangeJson = await get(`invoices?limit=100&total_minor[between]=${enc("[500,1000]")}`);
  ok(
    "grammar: number between, comma vs JSON, same rows",
    rangeJson.status === 200 && ids(rangeJson.body) === ids(rangeComma.body),
  );
  ok(
    "grammar: a bracketed non-JSON value still parses in the comma form",
    (await get(`invoices?limit=100&number[in]=${enc("[foo]")}`)).body.total === 0,
  );
  ok(
    "grammar: a JSON between with one bound is still a 400",
    (await get(`invoices?total_minor[between]=${enc("[500]")}`)).status === 400,
  );

  // ── Dates: `on=<unix>` names the business-zone day containing the instant.
  const tz = await withTenant(orgId, (tx) => businessTimezone(tx, biz.id));
  const nowUnix = Math.floor(Date.now() / 1000);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(nowUnix * 1000));
  const onDay = await get(`invoices?limit=100&created_at[on]=${today}`);
  const onUnix = await get(`invoices?limit=100&created_at[on]=${nowUnix}`);
  ok("grammar: on=<YYYY-MM-DD> still matches today's rows", (onDay.body.total ?? 0) > 0);
  ok(
    "grammar: on=<unix> equals on=<its business day>",
    onUnix.status === 200 && ids(onUnix.body) === ids(onDay.body),
  );
  ok(
    "grammar: a millisecond timestamp is refused, not read as a far-future day",
    (await get(`invoices?created_at[on]=${nowUnix * 1000}`)).status === 400,
  );

  // ── Offset paging walks the same rows as cursor paging, on keyset AND offset sorts.
  for (const sort of ["", "&sort_by[asc]=total_minor"]) {
    const walk = async (param: "starting_after" | "offset") => {
      const seen: string[] = [];
      let token: string | undefined;
      let tokensAgree = true;
      for (let guard = 0; guard < 50; guard++) {
        const qs = `invoices?limit=2${sort}${token ? `&${param}=${enc(token)}` : ""}`;
        const { body } = await get(qs);
        seen.push(...body.data.map((r) => r.id));
        if (body.has_more ? body.next_offset !== body.next_cursor : "next_offset" in body)
          tokensAgree = false;
        if (!body.has_more) break;
        token = param === "offset" ? body.next_offset : body.next_cursor!;
      }
      return { seen, tokensAgree };
    };
    const byCursor = await walk("starting_after");
    const byOffset = await walk("offset");
    const label = sort ? "sorted" : "default sort";
    ok(`paging (${label}): cursor walk reaches every row`, byCursor.seen.length === all.total);
    ok(
      `paging (${label}): offset walk visits the same rows in the same order`,
      byOffset.seen.join() === byCursor.seen.join(),
    );
    ok(
      `paging (${label}): next_offset equals next_cursor while has_more, absent after`,
      byCursor.tokensAgree && byOffset.tokensAgree,
    );
  }
  const p1 = (await get("invoices?limit=2")).body;
  ok(
    "paging: starting_after and a different offset together are a 400",
    (await get(`invoices?limit=2&starting_after=${enc(p1.next_cursor!)}&offset=o:1`)).status ===
      400,
  );

  // ── include_deleted: accepted everywhere it is declared, honoured where rows hide.
  const inc = await get("invoices?limit=100&include_deleted=true");
  ok("include_deleted: accepted on invoices, a truthful no-op", ids(inc.body) === ids(all));
  for (const path of ["credit_notes", "transactions", "events", "emails", "audit_logs"]) {
    ok(
      `include_deleted: accepted on ${path}`,
      (await get(`${path}?limit=1&include_deleted=false`)).status === 200,
    );
  }
  ok(
    "include_deleted: a non-boolean is a 400",
    (await get("invoices?include_deleted=yes")).status === 400,
  );
  ok(
    "include_deleted: still unknown where the list hides rows it cannot widen (segment preview)",
    (await get("customer_segments/preview?include_deleted=true")).status === 400,
  );

  const [archived] = await withTenant(orgId, (tx) =>
    tx
      .update(customers)
      .set({ active: false })
      .where(eq(customers.email, "pager-0@ex.com"))
      .returning({ publicId: customers.publicId }),
  );
  const cusDefault = (await get("customers?limit=1000")).body;
  const cusDeleted = (await get("customers?limit=1000&include_deleted=true")).body;
  const cusArchived = (await get("customers?limit=1000&include_archived=true")).body;
  ok(
    "include_deleted: customers hide an archived row by default",
    !cusDefault.data.some((c) => c.id === archived!.publicId),
  );
  ok(
    "include_deleted: customers widen exactly as include_archived does",
    cusDeleted.data.some((c) => c.id === archived!.publicId) &&
      ids(cusDeleted) === ids(cusArchived),
  );

  const subsBefore = (await get("subscriptions?limit=1000")).body;
  const victim = subsBefore.data[0]!;
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ deletedAt: new Date() })
      .where(eq(subscriptions.publicId, victim.id)),
  );
  const subsDefault = (await get("subscriptions?limit=1000")).body;
  const subsDeleted = (await get("subscriptions?limit=1000&include_deleted=true")).body;
  ok(
    "include_deleted: a deleted subscription stays hidden by default",
    !subsDefault.data.some((s) => s.id === victim.id) &&
      subsDefault.data.every((s) => s.deleted === undefined),
  );
  ok(
    "include_deleted: subscriptions widen to it, marked deleted",
    subsDeleted.data.find((s) => s.id === victim.id)?.deleted === true &&
      subsDeleted.data.length === subsBefore.data.length,
  );

  // ── New list filters.
  const recurringYes = (await get("invoices?limit=100&recurring[is]=true")).body;
  const recurringNo = (await get("invoices?limit=100&recurring[is]=false")).body;
  const withSub = (await get("invoices?limit=100&subscription[is_present]=true")).body;
  ok(
    "invoices: recurring splits the book into subscription and one-off invoices",
    (recurringYes.total ?? 0) > 0 &&
      (recurringNo.total ?? 0) > 0 &&
      recurringYes.total! + recurringNo.total! === all.total &&
      ids(recurringYes) === ids(withSub),
  );

  const [cnSub] = await withTenant(orgId, (tx) =>
    tx
      .select({ sub: subscriptions.publicId })
      .from(invoices)
      .innerJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
      .where(
        and(
          eq(invoices.businessId, biz.id),
          sql`EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice_id = ${invoices.id})`,
        ),
      )
      .limit(1),
  );
  const cnAll = (await get("credit_notes?limit=100")).body;
  const cnBySub = (await get(`credit_notes?limit=100&subscription[is]=${cnSub!.sub}`)).body;
  const cnNoSub = (await get("credit_notes?limit=100&subscription[is_present]=false")).body;
  ok("credit notes: subscription filter narrows to that subscription", (cnBySub.total ?? 0) >= 3);
  ok(
    "credit notes: subscription[is]=<unknown> matches nothing",
    (await get("credit_notes?limit=1&subscription[is]=sub_nope")).body.total === 0,
  );
  ok(
    "credit notes: that subscription's notes and the one-off notes do not overlap",
    cnBySub.total! + cnNoSub.total! <= cnAll.total!,
  );

  const payer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "grammar-payer@ex.com",
  });
  const card = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: payer,
    token: "tok_4242",
  });
  await recordTransaction({
    organizationId: orgId,
    businessId: biz.id,
    customerId: payer.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 700n,
    currency: "USD",
    gatewayKey: "tmtest",
    paymentMethodId: card.id,
  });
  ok(
    "transactions: payment_method filter narrows to that instrument",
    (await get(`transactions?limit=10&payment_method[is]=${card.publicId}`)).body.total === 1,
  );
  const txnsAsc = await get("transactions?limit=100&sort_by[asc]=updated_at");
  ok(
    "transactions: sortable by updated_at",
    txnsAsc.status === 200 && txnsAsc.body.data.length > 0,
  );

  // ── Unix bounds are exact instants; only `on` rounds to the day. LAST, because it moves
  // three invoices onto t-60 / t / t+60 around a mid-day business-zone instant t.
  {
    const localDay = (s: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(s * 1000));
    let t = Date.UTC(2020, 5, 15, 12) / 1000;
    if (localDay(t - 60) !== localDay(t + 60)) t += 6 * 3600;
    const day = localDay(t);
    const [atT, early, late] = all.data.slice(0, 3).map((r) => r.id) as [string, string, string];
    for (const [id, at] of [
      [atT, t],
      [early, t - 60],
      [late, t + 60],
    ] as const) {
      await withTenant(orgId, (tx) =>
        tx
          .update(invoices)
          .set({ createdAt: new Date(at * 1000) })
          .where(eq(invoices.publicId, id)),
      );
    }
    const trio = enc(JSON.stringify([atT, early, late]));
    const pick = async (filter: string) => {
      const { status, body } = await get(`invoices?limit=100&id[in]=${trio}&${filter}`);
      return status === 200
        ? body.data
            .map((r) => r.id)
            .sort()
            .join()
        : `HTTP ${status}`;
    };
    const rows = (...xs: string[]) => xs.sort().join();
    const cases: Array<[string, string, string]> = [
      ["after=t excludes the row AT t", `created_at[after]=${t}`, rows(late)],
      ["on_or_after=t includes the row at t", `created_at[on_or_after]=${t}`, rows(atT, late)],
      ["before=t excludes the row at t", `created_at[before]=${t}`, rows(early)],
      ["on_or_before=t includes the row at t", `created_at[on_or_before]=${t}`, rows(atT, early)],
      ["after=t-1 includes the row at t", `created_at[after]=${t - 1}`, rows(atT, late)],
      [
        "between [t,t] is exactly the row at t",
        `created_at[between]=${enc(`[${t},${t}]`)}`,
        rows(atT),
      ],
      [
        "between [t-60,t] is inclusive of both",
        `created_at[between]=${t - 60},${t}`,
        rows(atT, early),
      ],
      [
        "between day,t mixes a day bound and an instant",
        `created_at[between]=${day},${t}`,
        rows(atT, early),
      ],
      ["on=<unix> is still the whole business day", `created_at[on]=${t}`, rows(atT, early, late)],
      ["on=<day> unchanged", `created_at[on]=${day}`, rows(atT, early, late)],
      ["before=<day> unchanged (whole day)", `created_at[before]=${day}`, ""],
      ["after=<day> unchanged (whole day)", `created_at[after]=${day}`, ""],
      ["on_or_before=<day> unchanged", `created_at[on_or_before]=${day}`, rows(atT, early, late)],
      ["on_or_after=<day> unchanged", `created_at[on_or_after]=${day}`, rows(atT, early, late)],
    ];
    for (const [label, filter, want] of cases) {
      const got = await pick(filter);
      ok(`grammar: unix instant — ${label}${got === want ? "" : ` (got ${got})`}`, got === want);
    }
  }

  await app.close();
}

// ── Webhook deliveries (one endpoint's log) ──────────────────────────────────
{
  const o = await createOrganization({ name: "List Pagination Deliveries Org" });
  const oid = o.organization.id;
  const evs = await withTenant(oid, async (tx) => {
    const out = [];
    for (let i = 0; i < 5; i++)
      out.push(
        await emitEvent(tx, {
          organizationId: oid,
          type: "customer_created",
          data: buildEventData("customer_created", { id: `cus_lp${i}` }),
        }),
      );
    return out;
  });
  const ep = (await createEndpoint({ organizationId: oid, url: "http://127.0.0.1:9/hook" }))
    .endpoint;
  // Two rows share one created_at: the tiebreak has to keep both.
  const at = Date.now();
  await systemDb.insert(webhookDeliveries).values(
    evs.map((e, i) => ({
      organizationId: oid,
      eventId: e.id,
      endpointId: ep.id,
      status: "delivered",
      attempts: 1,
      lastResponseStatus: 200,
      createdAt: new Date(at - Math.min(i, 3) * 1000),
    })),
  );
  await assertPagedContract(
    "webhook deliveries",
    async (limit, cursor) =>
      (await listDeliveriesPage(oid, ep.publicId, { limit, startingAfter: cursor }))!,
    (r) => r.delivery.id,
    5,
  );
}

// ── Receipts and payment requests (0387, 0388) ───────────────────────────────
{
  const o9 = await createOrganization({ name: "Pager receipts" });
  const oid = o9.organization.id;
  const b9 = await createBusiness({
    organizationId: oid,
    name: "R",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const b9other = await createBusiness({
    organizationId: oid,
    name: "R2",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cus = await createCustomer({ organizationId: oid, businessId: b9.id, email: "rc@ex.com" });
  const cus2 = await createCustomer({
    organizationId: oid,
    businessId: b9other.id,
    email: "rc2@ex.com",
  });
  const at = Date.now();
  // Two rows share a created_at so the tiebreak is exercised.
  await systemDb.insert(receipts).values(
    Array.from({ length: 5 }, (_, i) => ({
      organizationId: oid,
      businessId: b9.id,
      customerId: cus.id,
      publicId: publicId("rcpt"),
      transactionId: randomUUID(),
      amountMinor: BigInt(100 + i),
      currency: "USD",
      paidAt: new Date(at),
      snapshot: { payer: { id: cus.publicId }, payments: [], allocations: [], method: "Cash" },
      createdAt: new Date(at - Math.min(i, 3) * 1000),
    })),
  );
  await systemDb.insert(receipts).values({
    organizationId: oid,
    businessId: b9other.id,
    customerId: cus2.id,
    publicId: publicId("rcpt"),
    transactionId: randomUUID(),
    amountMinor: 5n,
    currency: "USD",
    paidAt: new Date(at),
    snapshot: { payer: { id: cus2.publicId }, payments: [], allocations: [], method: "Cash" },
  });
  await assertPagedContract(
    "receipts",
    (limit, cursor) => listReceiptsPage(oid, b9.id, { limit, startingAfter: cursor }),
    (r) => r.receipt.publicId,
    5,
  );
  ok(
    "receipts: a filter narrows in SQL",
    (
      await listReceiptsPage(oid, b9.id, {
        filters: [{ field: "amount_minor", op: "gte", value: "103" }],
      })
    ).total === 2,
  );
  ok(
    "receipts: list is scoped to its business",
    (await listReceiptsPage(oid, b9other.id)).total === 1,
  );

  await systemDb.insert(paymentRequests).values(
    Array.from({ length: 5 }, (_, i) => ({
      organizationId: oid,
      businessId: b9.id,
      customerId: cus.id,
      publicId: publicId("preq"),
      status: "canceled",
      mode: "link",
      currency: "USD",
      createdAmountMinor: 100n,
      expiresAt: new Date(at + 86_400_000),
      createdAt: new Date(at - Math.min(i, 3) * 1000),
    })),
  );
  await assertPagedContract(
    "payment requests",
    (limit, cursor) => listPaymentRequestsPage(oid, b9.id, { limit, startingAfter: cursor }),
    (r) => r.request.publicId,
    5,
  );
  ok(
    "payment requests: list is scoped to its business",
    (await listPaymentRequestsPage(oid, b9other.id)).total === 0,
  );
}

let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ LIST PAGINATION: PASS" : "❌ LIST PAGINATION: FAIL");
await retireFixtureRetries(retriesOrgs);
await closeDb();
process.exit(pass ? 0 : 1);
