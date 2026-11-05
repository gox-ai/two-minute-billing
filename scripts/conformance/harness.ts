/**
 * One isolated world per scenario: its own business (so its cash account is its own), one
 * gateway account on the fake, and helpers that go through the real engine and the real
 * webhook route.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { withTenant, systemDb } from "@/platform/db";
import { createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { buildNotificationUrl } from "@/modules/gateway/webhook-endpoint";
import {
  PROCESS_GATEWAY_WEBHOOK_TASK,
  processStoredGatewayWebhook,
  type StoredDeliveryJob,
} from "@/modules/gateway/inbound";
import { gatewayDefinition } from "@/providers/gateway-catalog";
import { config } from "@/platform/config";
import { Logger, runOnce } from "graphile-worker";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  collectInvoice,
  CollectionDeferredError,
} from "@/modules/invoicing/service";
import { accountBalance } from "@/modules/ledger/service";
import {
  businesses,
  disputes,
  events,
  invoices,
  ledgerEntries,
  payments,
  preDebitNotices,
  providerEvents,
  refunds,
  subscriptions,
  transactions,
} from "@db/schema";
import type { Billed, Body, GatewayDriver, GatewayFixture, TokenKind } from "./types";

export const AMOUNT = 10_000n;

export interface Org {
  id: string;
  secret: string;
}

export interface World {
  fixture: GatewayFixture;
  driver: GatewayDriver;
  app: FastifyInstance;
  org: Org;
  biz: { id: string; publicId: string };
  account: { id: string; publicId: string };
  secret: string;
  notificationUrl: string;
  /** `onVaulted` runs between the vault and the bill, to change the stored method. */
  bill(
    kind?: TokenKind,
    opts?: { onVaulted?(paymentMethodId: string): Promise<void> },
  ): Promise<Billed>;
  /** Bill with a card that pays, then make the money arrive. */
  collected(): Promise<Billed>;
  /** An issued invoice for a customer with no payment method: open, nothing collected. */
  openInvoice(): Promise<{
    invoiceId: string;
    invoicePublicId: string;
    customerPublicId: string;
  }>;
  deliver(bodies: Body | Body[], opts?: { secret?: string }): Promise<Delivered>;
  /** Deliver the last delivery again, byte for byte. */
  redeliver(): Promise<Delivered>;
  cash(): Promise<bigint>;
  bal(account: string): Promise<bigint>;
  entries(): Promise<number>;
  balanced(): Promise<boolean>;
  reload(billed: Billed): Promise<Billed>;
  refundRows(paymentId: string): Promise<(typeof refunds.$inferSelect)[]>;
  dispute(providerDisputeId: string): Promise<typeof disputes.$inferSelect | undefined>;
  invoiceStatus(invoiceId: string): Promise<string>;
  /** Normalized types the route recorded for these provider event ids. */
  recordedTypes(eventIds: string[]): Promise<string[]>;
  eventRows(eventIds: string[]): Promise<(typeof providerEvents.$inferSelect)[]>;
}

export interface Delivered {
  status: number;
  results: string[];
}

const RUN = randomUUID().slice(0, 8);
let n = 0;

/**
 * Run the queued `process_gateway_webhook` jobs through graphile-worker, as a worker would. A
 * gateway that answers before processing (`webhook.processAfterAnswer`) books nothing until then.
 */
export async function drainStoredWebhooks(): Promise<void> {
  await runOnce({
    connectionString: config.DATABASE_URL,
    concurrency: 1,
    noHandleSignals: true,
    logger: new Logger(() => () => {}),
    taskList: {
      [PROCESS_GATEWAY_WEBHOOK_TASK]: async (payload) => {
        await processStoredGatewayWebhook(payload as StoredDeliveryJob);
      },
    },
  });
}

export async function newWorld(
  fixture: GatewayFixture,
  driver: GatewayDriver,
  app: FastifyInstance,
  org: Org,
  label: string,
): Promise<World> {
  const biz = await createBusiness({
    organizationId: org.id,
    name: `GC ${fixture.key} ${label}`,
    defaultCurrency: fixture.currency,
    livemode: "test",
  });
  // Charges here are made on purpose, never by a card being added.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { collect_on_payment_method_update: false } })
    .where(eq(businesses.id, biz.id));
  const ctx = { organizationId: org.id, businessId: biz.id };
  const secret = `whsec_conf_${randomBytes(12).toString("hex")}`;
  const account = await createGatewayAccount({
    ...ctx,
    gatewayKey: fixture.key,
    label: `${fixture.key} conformance`,
    credentials: driver.credentials(secret),
  });
  const notificationUrl = buildNotificationUrl({
    gatewayKey: fixture.key,
    gatewayAccountPublicId: account.publicId,
  });
  const product = await createProduct({ ...ctx, name: "Plan" });
  const price = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: fixture.currency,
    amountMinor: Number(AMOUNT),
    interval: "month",
  });
  let last: { bodies: Body[]; secret: string } | null = null;

  const reload = async (b: Billed): Promise<Billed> => {
    const [pay] = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, b.invoiceId))
        .orderBy(desc(payments.createdAt))
        .limit(1),
    );
    const [txn] = await withTenant(org.id, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.invoiceId, b.invoiceId), eq(transactions.type, "payment")))
        .orderBy(desc(transactions.createdAt))
        .limit(1),
    );
    return {
      ...b,
      paymentId: pay?.id ?? null,
      paymentPublicId: pay?.publicId ?? null,
      chargeId: txn?.idAtGateway || pay?.providerChargeId || "",
      txnStatus: txn?.status ?? null,
      paymentStatus: pay?.status ?? null,
      failureCode: txn?.errorCode ?? pay?.failureCode ?? null,
    };
  };

  const w: World = {
    fixture,
    driver,
    app,
    org,
    biz: { id: biz.id, publicId: biz.publicId },
    account: { id: account.id, publicId: account.publicId },
    secret,
    notificationUrl,
    async bill(kind = "pays", opts = {}) {
      const token = driver.token(kind);
      if (!token) throw new Error(`${fixture.key} has no ${kind} instrument`);
      const customer = await createCustomer({
        ...ctx,
        email: `conf-${label}-${++n}-${RUN}@example.com`,
        firstName: "Conformance",
        lastName: "Payer",
      });
      const pm = await vaultPaymentMethod({
        ...ctx,
        customer,
        token,
        gatewayAccountId: account.publicId,
      });
      await opts.onVaulted?.(pm.id);
      const sub = await createSubscription({
        ...ctx,
        customerId: customer.id,
        now: new Date(),
        items: [{ price, quantity: 1 }],
        defaultPaymentMethodId: pm.id,
      });
      const { invoice } = await billSubscriptionPeriod({
        ...ctx,
        subscription: sub.subscription,
        periodStart: sub.subscription.currentPeriodStart!,
        periodEnd: sub.subscription.currentPeriodEnd!,
      });
      await collectAfterNotice(org.id, biz.id, invoice.id, sub.subscription);
      return reload({
        invoiceId: invoice.id,
        invoicePublicId: invoice.publicId,
        paymentId: null,
        paymentPublicId: null,
        chargeId: "",
        txnStatus: null,
        paymentStatus: null,
        failureCode: null,
        subscriptionId: sub.subscription.id,
        customerId: customer.id,
        paymentMethodId: pm.id,
        amountMinor: AMOUNT,
      });
    },
    async openInvoice() {
      const customer = await createCustomer({
        ...ctx,
        email: `conf-${label}-${++n}-${RUN}@example.com`,
        firstName: "Conformance",
        lastName: "Payer",
      });
      const sub = await createSubscription({
        ...ctx,
        customerId: customer.id,
        now: new Date(),
        items: [{ price, quantity: 1 }],
      });
      const { invoice } = await billSubscriptionPeriod({
        ...ctx,
        subscription: sub.subscription,
        periodStart: sub.subscription.currentPeriodStart!,
        periodEnd: sub.subscription.currentPeriodEnd!,
      });
      return {
        invoiceId: invoice.id,
        invoicePublicId: invoice.publicId,
        customerPublicId: customer.publicId,
      };
    },
    async collected() {
      const b = await w.bill("pays");
      if (!b.chargeId) throw new Error(`${fixture.key}: the charge left no gateway id`);
      const bodies = driver.collect(w, b.chargeId);
      const res = bodies.length ? await w.deliver(bodies) : null;
      const after = await reload(b);
      if (after.txnStatus !== "succeeded")
        throw new Error(
          `${fixture.key}: expected a collected charge, got ${after.txnStatus}` +
            (res ? ` (webhook ${res.status} ${res.results.join(",")})` : ""),
        );
      return after;
    },
    async deliver(bodies, opts = {}) {
      const list = Array.isArray(bodies) ? bodies : [bodies];
      let status = 200;
      const results: string[] = [];
      for (const b of list) {
        const useSecret = opts.secret ?? secret;
        last = { bodies: list, secret: useSecret };
        const payload = driver.signBody ? driver.signBody(w, b.body, useSecret) : b.body;
        const res = await app.inject({
          method: "POST",
          // The route itself; `notificationUrl` may carry the base URL's path prefix.
          url: `/v1/gateway_webhooks/${fixture.key}?id=${account.publicId}`,
          headers: {
            "content-type": "application/json",
            host: new URL(notificationUrl).host,
            ...driver.sign(w, payload, useSecret),
          },
          payload,
        });
        if (res.statusCode !== 200) status = res.statusCode;
        try {
          results.push(...((res.json() as { results?: string[] }).results ?? []));
        } catch {
          results.push(`http_${res.statusCode}`);
        }
      }
      if (gatewayDefinition(fixture.key)?.webhook.processAfterAnswer) await drainStoredWebhooks();
      return { status, results };
    },
    async redeliver() {
      if (!last) throw new Error("nothing delivered yet");
      return w.deliver(last.bodies, { secret: last.secret });
    },
    cash: () => accountBalance(org.id, biz.id, "cash", fixture.currency),
    bal: (acc) => accountBalance(org.id, biz.id, acc, fixture.currency),
    async entries() {
      return (
        await withTenant(org.id, (tx) =>
          tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, biz.id)),
        )
      ).length;
    },
    async balanced() {
      const rows = await withTenant(org.id, (tx) =>
        tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, biz.id)),
      );
      const net = new Map<string, bigint>();
      for (const r of rows) {
        const k = `${r.transactionId}:${r.currency}`;
        net.set(k, (net.get(k) ?? 0n) + (r.direction === "debit" ? r.amountMinor : -r.amountMinor));
      }
      return [...net.values()].every((v) => v === 0n);
    },
    reload,
    refundRows: (paymentId) =>
      withTenant(org.id, (tx) => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId))),
    async dispute(id) {
      return (
        await withTenant(org.id, (tx) =>
          tx
            .select()
            .from(disputes)
            .where(and(eq(disputes.businessId, biz.id), eq(disputes.providerDisputeId, id))),
        )
      )[0];
    },
    async invoiceStatus(id) {
      const [inv] = await withTenant(org.id, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, id)),
      );
      return inv?.status ?? "missing";
    },
    async eventRows(ids) {
      const rows = await systemDb
        .select()
        .from(providerEvents)
        .where(
          and(eq(providerEvents.providerKey, fixture.key), eq(providerEvents.businessId, biz.id)),
        );
      return rows.filter((r) =>
        ids.some(
          (e) =>
            r.providerEventId === e ||
            r.providerEventId.startsWith(`${e}#`) ||
            r.providerEventId.startsWith(`${e}:`),
        ),
      );
    },
    async recordedTypes(ids) {
      return (await w.eventRows(ids)).map((r) => r.type).sort();
    },
  };
  return w;
}

/**
 * A notice-rail gateway (`preDebitNotice`) defers the first collection behind a sent notice.
 * Skip its lead time and collect, as the clock would once it has passed.
 */
async function collectAfterNotice(
  orgId: string,
  businessId: string,
  invoiceId: string,
  subscription: typeof subscriptions.$inferSelect,
): Promise<void> {
  const [notice] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(preDebitNotices)
      .where(and(eq(preDebitNotices.invoiceId, invoiceId), eq(preDebitNotices.status, "sent")))
      .limit(1),
  );
  if (!notice) return;
  const booked = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)),
  );
  if (booked.length) return;
  await withTenant(orgId, (tx) =>
    tx
      .update(preDebitNotices)
      .set({ executableAfter: new Date(Date.now() - 60_000) })
      .where(eq(preDebitNotices.id, notice.id)),
  );
  const [inv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
  );
  await collectInvoice({ organizationId: orgId, businessId, invoice: inv!, subscription }).catch(
    (e: unknown) => {
      if (!(e instanceof CollectionDeferredError)) throw e;
    },
  );
}

/** The subscription row, for a second collection attempt. */
export async function subscriptionOf(w: World, id: string) {
  const [sub] = await withTenant(w.org.id, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, id)),
  );
  return sub!;
}

export async function invoiceOf(w: World, id: string) {
  const [inv] = await withTenant(w.org.id, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, id)),
  );
  return inv!;
}

/** What the attempt came to: the transaction's status, else the payment row's. */
export const outcomeOf = (b: Billed) => b.txnStatus ?? b.paymentStatus ?? "none";

export async function txnsOf(w: World, invoiceId: string) {
  return withTenant(w.org.id, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.type, "payment")))
      .orderBy(desc(transactions.createdAt)),
  );
}

/** Event types this world's business emitted, oldest first. */
export async function eventTypesOf(w: World): Promise<string[]> {
  const rows = await withTenant(w.org.id, (tx) =>
    tx
      .select({ type: events.type })
      .from(events)
      .where(eq(events.businessId, w.biz.id))
      .orderBy(events.createdAt),
  );
  return rows.map((r) => r.type);
}

/**
 * A pending debit cancelled at the gateway and found by the stale-pending sweep before its
 * webhook: booked as the webhook books it, and the webhook that follows changes nothing.
 */
export async function sweptCancelBeforeWebhook(
  w: World,
  b: Billed,
  webhook: () => Body | Body[],
): Promise<{ pass: boolean; detail: string }> {
  const { runWithClockScope } = await import("@/platform/clock");
  const { sweepStalePendingCharges } = await import("@/modules/payments/stale-pending");
  const cash0 = await w.cash();
  const n0 = await w.entries();
  const [txn] = await txnsOf(w, b.invoiceId);
  await runWithClockScope({ onlyBusinessId: w.biz.id }, () =>
    sweepStalePendingCharges(new Date(), { onlyTransactionId: txn!.id }),
  );
  const swept = await w.reload(b);
  const inv = await invoiceOf(w, b.invoiceId);
  const types = await eventTypesOf(w);
  const refundRows = await w.refundRows(b.paymentId!);
  const n1 = await w.entries();
  await w.deliver(webhook());
  const after = await w.reload(b);
  const inv2 = await invoiceOf(w, b.invoiceId);
  const types2 = await eventTypesOf(w);
  const pass =
    swept.paymentStatus === "failed" &&
    swept.failureCode === "debit_cancelled" &&
    inv.status === "payment_due" &&
    inv.dunningStatus === "stopped" &&
    inv.nextAttemptAt === null &&
    !types.includes("invoice_not_paid") &&
    types.includes("invoice_dunning_stopped") &&
    refundRows.length === 0 &&
    (await w.cash()) === cash0 &&
    n1 === n0 &&
    // The webhook after the sweep is a no-op.
    after.paymentStatus === "failed" &&
    after.failureCode === "debit_cancelled" &&
    inv2.status === inv.status &&
    inv2.dunningStatus === inv.dunningStatus &&
    types2.length === types.length &&
    (await w.entries()) === n1 &&
    (await w.balanced());
  return {
    pass,
    detail:
      `payment ${swept.paymentStatus} ${swept.failureCode} invoice ${inv.status}/${inv.dunningStatus} ` +
      `not_paid ${types.includes("invoice_not_paid")} refunds ${refundRows.length} ` +
      `entries ${n1 - n0} cash ${(await w.cash()) - cash0}; after webhook invoice ` +
      `${inv2.status}/${inv2.dunningStatus} events +${types2.length - types.length}`,
  };
}
