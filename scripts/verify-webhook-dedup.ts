/**
 * Inbound gateway webhooks are deduped per (gateway, business, event), by an id that is
 * stable across the gateway's retries and different for every event.
 *
 * What regresses without it:
 *  - RazorPay sends its event id in a header we did not read, so the key fell back to
 *    `<event name>_<created_at second>`: two payments captured in the same second shared
 *    a key and the second was dropped as a duplicate.
 *  - The key was platform-wide, so a gateway account shared by two businesses (which
 *    receive every event at both webhook URLs) applied each event in only one of them.
 *
 * §A holds EVERY adapter to the `webhookEventId` contract. The fixture table is typed
 * `Record<ProviderKey, …>`, so a new adapter does not typecheck until it has a fixture.
 * §B drives the shared-account case end to end through the real route.
 *
 *   pnpm verify:webhook-dedup
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { distinctEventIds, recordGatewayWebhookResponse } from "@/modules/gateway/inbound";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { GATEWAY_FACTORIES, type GatewayCredentials } from "@/providers/gateways";
import { signTmtest } from "@/providers/tmtest/signing";
import { signBraintreePayload } from "@/providers/braintree";
import { signAdyenItem, type AdyenNotificationItem } from "@/providers/adyen";
import { signCheckoutcomPayload } from "@/providers/checkoutcom";
import { signAuthorizenetPayload } from "@/providers/authorizenet";
import { signSquarePayload } from "@/providers/square";
import { payuReverseHash } from "@/providers/payu";
import { signCybersourceWebhook } from "@/providers/cybersource";
import type { NormalizeWebhookInput, ProviderKey } from "@/providers/types";
import { gatewayAccounts, providerEvents } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = randomUUID().slice(0, 8);
const SECRET = `whsec_dedup_${RUN}`;
const CREATED = 1_792_000_000;

interface Delivery {
  body: string;
  headers: Record<string, string>;
}

interface Fixture {
  creds: GatewayCredentials;
  /** Two DIFFERENT events of the same type at the same second — the shape that collided. */
  delivery(n: 1 | 2): Delivery;
  /**
   * Sign a delivery so `normalizeWebhook` accepts it offline, or say why the gateway cannot
   * be signed offline (then only the pure `webhookEventId` is checked).
   */
  sign: ((d: Delivery) => Record<string, string>) | { offline: false; reason: string };
}

const rzpBody = (n: number) =>
  JSON.stringify({
    entity: "event",
    account_id: "acc_XXXXXXXXXXXX01",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: `pay_XXXXXXXXXX${RUN.slice(0, 2)}${n}`,
          order_id: `order_XXXXXXXXXX${RUN.slice(0, 2)}${n}`,
          amount: 99_900,
          currency: "INR",
          status: "captured",
          captured: true,
          notes: {},
          created_at: CREATED,
        },
      },
    },
    created_at: CREATED,
  });

/** Adyen signs each item with a hex HMAC key; the fixture signs before it serialises. */
const ADYEN_HMAC = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
const adyenItem = (n: number): AdyenNotificationItem => {
  const item: AdyenNotificationItem = {
    eventCode: "AUTHORISATION",
    success: "true",
    pspReference: `PSP${RUN.slice(0, 6).toUpperCase()}000${n}`,
    merchantAccountCode: "TestMerchantECOM",
    merchantReference: `tmc:pay_${RUN}_${n}`,
    amount: { value: 1000, currency: "EUR" },
    eventDate: new Date(CREATED * 1000).toISOString(),
    additionalData: {},
  };
  item.additionalData!.hmacSignature = signAdyenItem(ADYEN_HMAC, item);
  return item;
};

const FIXTURES: Record<ProviderKey, Fixture> = {
  razorpay: {
    creds: {
      key_id: "rzp_test_x",
      key_secret: "x",
      api_base: "https://rzp.invalid",
      webhook_secret: SECRET,
    },
    delivery: (n) => ({ body: rzpBody(n), headers: { "x-razorpay-event-id": `evt_${RUN}_${n}` } }),
    sign: (d) => ({
      "x-razorpay-signature": createHmac("sha256", SECRET).update(d.body).digest("hex"),
    }),
  },
  stripe: {
    creds: { secret_key: "sk_test_x", webhook_secret: SECRET },
    delivery: (n) => ({
      body: JSON.stringify({
        id: `evt_${RUN}_${n}`,
        object: "event",
        type: "customer.updated",
        created: CREATED,
        livemode: false,
        data: { object: { id: `cus_XXXXXXXXXX0${n}`, object: "customer", metadata: {} } },
      }),
      headers: {},
    }),
    sign: (d) => ({
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload: d.body,
        secret: SECRET,
      }),
    }),
  },
  paypal: {
    creds: {
      client_id: "x",
      client_secret: "x",
      api_base: "https://paypal.invalid",
      webhook_id: "WH-X",
    },
    delivery: (n) => ({
      body: JSON.stringify({
        id: `WH-${RUN}-${n}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        create_time: new Date(CREATED * 1000).toISOString(),
        resource: { id: `CAPTURE-XXXXXXXXX0${n}`, status: "COMPLETED" },
      }),
      headers: {},
    }),
    sign: {
      offline: false,
      reason: "PayPal verifies against a certificate served from *.paypal.com",
    },
  },
  // One event per delivery here; a batch keeps each event's own id (verify:gocardless).
  gocardless: {
    creds: { access_token: "x", api_base: "https://gocardless.invalid", webhook_secret: SECRET },
    delivery: (n) => ({
      body: JSON.stringify({
        events: [
          {
            id: `EV${RUN}${n}`,
            created_at: new Date(CREATED * 1000).toISOString(),
            resource_type: "payments",
            action: "submitted",
            links: { payment: `PM${RUN}0${n}` },
            details: { origin: "gocardless", cause: "payment_submitted" },
          },
        ],
        meta: { webhook_id: `WB${RUN}${n}` },
      }),
      headers: {},
    }),
    sign: (d) => ({
      "webhook-signature": createHmac("sha256", SECRET).update(d.body).digest("hex"),
    }),
  },
  braintree: {
    creds: { merchant_id: "m", public_key: "pk_dedup", private_key: SECRET },
    // Braintree sends no event id: two settlements in the same second differ by transaction.
    delivery: (n) => {
      const xml =
        `<notification><timestamp type="datetime">${new Date(CREATED * 1000).toISOString()}</timestamp>` +
        `<kind>transaction_settled</kind><subject><transaction><id>tx${RUN.slice(0, 4)}${n}</id>` +
        `<status>settled</status><type>sale</type></transaction></subject></notification>`;
      const payload = `${Buffer.from(xml).toString("base64")}\n`;
      const body = new URLSearchParams({
        bt_signature: signBraintreePayload("pk_dedup", SECRET, payload),
        bt_payload: payload,
      }).toString();
      return { body, headers: { "content-type": "application/x-www-form-urlencoded" } };
    },
    sign: () => ({}),
  },
  cashfree: {
    creds: { app_id: "cf_test_x", secret_key: SECRET },
    delivery: (n) => ({
      body: JSON.stringify({
        data: {
          payment_id: `tms_00000000000000${RUN.slice(0, 2)}-00000000000${n}`,
          subscription_id: `tms_00000000000000${RUN.slice(0, 2)}`,
          payment_type: "CHARGE",
          payment_amount: 999.0,
          payment_status: "SUCCESS",
        },
        event_time: "2026-10-24T10:00:00+05:30",
        type: "SUBSCRIPTION_PAYMENT_SUCCESS",
      }),
      headers: { "x-idempotency-key": `idem_${RUN}_${n}` },
    }),
    // Cashfree signs timestamp + body; the timestamp must be fresh.
    sign: (d) => {
      const ts = String(Date.now());
      return {
        "x-webhook-timestamp": ts,
        "x-webhook-signature": createHmac("sha256", SECRET)
          .update(ts + d.body)
          .digest("base64"),
      };
    },
  },
  // No event id: pspReference + eventCode + success names one event (Adyen's duplicate rule).
  adyen: {
    creds: {
      api_key: "x",
      client_key: "test_x",
      merchant_account: "TestMerchantECOM",
      webhook_secret: ADYEN_HMAC,
    },
    delivery: (n) => ({
      body: JSON.stringify({
        live: "false",
        notificationItems: [{ NotificationRequestItem: adyenItem(n) }],
      }),
      headers: { "content-type": "application/json" },
    }),
    sign: () => ({}),
  },
  checkoutcom: {
    creds: {
      secret_key: "sk_sbox_dedup",
      public_key: "pk_sbox_dedup",
      processing_channel_id: "pc_dedup",
      api_prefix: "dedup123",
      default_country: "US",
      entity_id: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      webhook_secret: SECRET,
    },
    // Two captures in the same second differ by their event id.
    delivery: (n) => ({
      body: JSON.stringify({
        id: `evt_${RUN}${n}`,
        type: "payment_captured",
        created_on: new Date(CREATED * 1000).toISOString(),
        data: { id: `pay_${RUN}${n}`, amount: 1000, currency: "USD" },
      }),
      headers: {},
    }),
    sign: (d) => ({ "cko-signature": signCheckoutcomPayload(SECRET, d.body) }),
  },
  // A payment-profile deletion: translated without a transaction read, so it runs offline.
  authorizenet: {
    creds: {
      api_login_id: "x",
      transaction_key: "x",
      signature_key: "ab".repeat(64),
      api_base: "https://anet.invalid",
    },
    delivery: (n) => ({
      body: JSON.stringify({
        notificationId: `00000000-0000-4000-8000-${RUN}000${n}`,
        eventType: "net.authorize.customer.paymentProfile.deleted",
        eventDate: new Date(CREATED * 1000).toISOString(),
        webhookId: "00000000-0000-4000-8000-000000000001",
        payload: {
          entityName: "customerPaymentProfile",
          id: `90000000${n}`,
          customerProfileId: 900000000,
        },
      }),
      headers: {},
    }),
    sign: (d) => ({ "x-anet-signature": signAuthorizenetPayload("ab".repeat(64), d.body) }),
  },
  // A card disable: translated from the payload alone, so it runs offline. Square signs the URL too.
  square: {
    creds: {
      access_token: "x",
      application_id: "sandbox-sq0idb-XXXXXXXXXXXXXXXXXXXX01",
      location_id: "LXXXXXXXXXXX1",
      webhook_secret: SECRET,
      notification_url: "https://hooks.example.com/v1/gateway_webhooks/square?id=gwa_x",
      api_base: "https://square.invalid",
    },
    delivery: (n) => ({
      body: JSON.stringify({
        merchant_id: "MXXXXXXXXXXX1",
        type: "card.disabled",
        event_id: `00000000-0000-4000-8000-${RUN}000${n}`,
        created_at: new Date(CREATED * 1000).toISOString(),
        data: {
          type: "card",
          id: `ccof:XXXXXXXXXXXXXXXX0${n}`,
          object: { card: { id: `ccof:XXXXXXXXXXXXXXXX0${n}`, enabled: false } },
        },
      }),
      headers: {},
    }),
    sign: (d) => ({
      "x-square-hmacsha256-signature": signSquarePayload(
        SECRET,
        "https://hooks.example.com/v1/gateway_webhooks/square?id=gwa_x",
        d.body,
      ),
    }),
  },
  // A classic delivery is `id=tr_…` only. Each event is keyed on the state fetched back
  // from Mollie (verify:mollie), so normalizeWebhook needs the API.
  mollie: {
    creds: { api_key: "test_dedupdedupdedupdedupdedupdedup", api_base: "https://mollie.invalid" },
    delivery: (n) => ({ body: `id=tr_${RUN}0${n}`, headers: {} }),
    sign: {
      offline: false,
      reason:
        "Mollie sends an unsigned id; the events come from the payment read back from its API",
    },
  },
  // Two renewals settled in the same second differ by their mihpayid. The hash is in the body.
  payu: {
    creds: { merchant_key: "pyKey1", merchant_salt: SECRET },
    delivery: (n) => {
      const f: Record<string, string> = {
        mihpayid: `2000000${RUN.replace(/[^0-9]/g, "").slice(0, 3)}${n}`,
        mode: "CC",
        status: "success",
        unmappedstatus: "captured",
        key: "pyKey1",
        txnid: `tmrc${RUN}${n}`,
        amount: "999.00",
        addedon: "2026-10-24 10:00:00",
        productinfo: "Renewal",
        firstname: "Test",
        email: "payer@example.com",
        udf1: `ref_${n}`,
      };
      f.hash = payuReverseHash(SECRET, f);
      return {
        body: new URLSearchParams(f).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      };
    },
    sign: () => ({}),
  },
  // A token update naming no payment instrument: translated without a read, so it runs offline.
  cybersource: {
    creds: {
      organization_id: "testorg_1234567890",
      key_id: "00000000-0000-4000-8000-000000000001",
      shared_secret: Buffer.alloc(32, 7).toString("base64"),
      webhook_secret: `00000000-0000-4000-8000-0000000000aa:${Buffer.alloc(32, 9).toString("base64")}`,
      api_base: "https://cybs.invalid",
    },
    delivery: (n) => ({
      body: JSON.stringify({
        eventType: "tms.networktoken.updated",
        webhookId: "00000000-0000-4000-8000-000000000002",
        productId: "tokenManagement",
        organizationId: "testorg_1234567890",
        eventDate: new Date(CREATED * 1000).toISOString().slice(0, 19),
        transactionTraceId: `00000000-0000-4000-8000-${RUN}000${n}`,
        retryNumber: 0,
        payload: {
          data: { id: `${RUN}000${n}`, type: "tokenizedCardEnrollments", version: "1.0" },
        },
        requestType: "NEW",
      }),
      headers: {},
    }),
    sign: (d) => ({
      "v-c-signature": signCybersourceWebhook(
        `00000000-0000-4000-8000-0000000000aa:${Buffer.alloc(32, 9).toString("base64")}`,
        String(CREATED * 1000),
        d.body,
      ),
    }),
  },
  tmtest: {
    creds: {},
    delivery: (n) => {
      const evt = {
        id: `tmevt_${RUN}_${n}`,
        type: "tmtest.unmapped",
        occurred_at: new Date(CREATED * 1000).toISOString(),
        data: {},
      };
      return { body: JSON.stringify(evt), headers: { "x-tmtest-signature": signTmtest(evt) } };
    },
    sign: (d) => ({ "x-tmtest-signature": d.headers["x-tmtest-signature"]! }),
  },
};

const input = (d: Delivery, extra: Record<string, string> = {}): NormalizeWebhookInput => ({
  payload: d.body,
  headers: { ...d.headers, ...extra },
});

/** §A — every adapter: stable across a replay, distinct across events, used by normalizeWebhook. */
async function adapterContract() {
  for (const key of Object.keys(GATEWAY_FACTORIES) as ProviderKey[]) {
    const fx = FIXTURES[key];
    const adapter = GATEWAY_FACTORIES[key].build(fx.creds, {
      businessId: randomUUID(),
      livemode: false,
    });
    const d1 = fx.delivery(1);
    const d2 = fx.delivery(2);
    const id1 = adapter.webhookEventId(input(d1));
    ok(`${key}: a redelivery keeps its id`, adapter.webhookEventId(input(d1)) === id1, id1);
    ok(
      `${key}: two events of one type in the same second get different ids`,
      adapter.webhookEventId(input(d2)) !== id1,
    );
    if ("offline" in fx.sign) {
      console.log(`   ${key}: normalizeWebhook not run offline — ${fx.sign.reason}`);
      continue;
    }
    for (const d of [d1, d2]) {
      const events = await adapter.normalizeWebhook(input(d, fx.sign(d)));
      const want = adapter.webhookEventId(input(d));
      ok(
        `${key}: normalizeWebhook stamps every event with webhookEventId`,
        events.length > 0 && events.every((e) => e.providerEventId === want),
        `${events.map((e) => e.providerEventId).join(",")} vs ${want}`,
      );
    }
  }

  const rzp = GATEWAY_FACTORIES.razorpay.build(FIXTURES.razorpay.creds, {
    businessId: randomUUID(),
    livemode: false,
  });
  const bare = (n: 1 | 2): NormalizeWebhookInput => ({ payload: rzpBody(n), headers: {} });
  ok(
    "razorpay: the x-razorpay-event-id header is the id",
    rzp.webhookEventId(input(FIXTURES.razorpay.delivery(1))) === `evt_${RUN}_1`,
  );
  ok(
    "razorpay: with no header, two same-second captures still get different ids",
    rzp.webhookEventId(bare(1)) !== rzp.webhookEventId(bare(2)) &&
      rzp.webhookEventId(bare(1)).startsWith("sha256:"),
  );

  const fanned = distinctEventIds([
    { providerEventId: "e" },
    { providerEventId: "e" },
    { providerEventId: "f" },
  ]);
  ok(
    "one delivery fanned out to two events keeps both",
    fanned.map((e) => e.providerEventId).join(",") === "e,e#2,f",
  );
}

/** §B — one RazorPay account connected in two businesses: each applies every event once. */
async function sharedAccount() {
  const app = await buildApp({ logger: false });
  try {
    const org = await createOrganization({ name: `Webhook Dedup Co ${RUN}` });
    const orgId = org.organization.id;
    const accounts: { biz: string; gwa: string }[] = [];
    for (const name of ["Dedup A", "Dedup B"]) {
      const biz = await createBusiness({
        organizationId: orgId,
        name,
        defaultCurrency: "INR",
        livemode: "test",
      });
      const acct = await createGatewayAccount({
        organizationId: orgId,
        businessId: biz.id,
        gatewayKey: "razorpay",
        label: "Shared RazorPay",
        credentials: FIXTURES.razorpay.creds as Record<string, string>,
      });
      accounts.push({ biz: biz.id, gwa: acct.publicId });
    }
    // An event no handler acts on, so the check is about the log row and not about money.
    const body = (n: number) =>
      JSON.stringify({
        entity: "event",
        event: "virtual_account.created",
        payload: {},
        created_at: CREATED + n,
      });
    const post = (gwa: string, b: string, eventId: string) =>
      app.inject({
        method: "POST",
        url: `/v1/gateway_webhooks/razorpay?id=${gwa}`,
        headers: {
          "content-type": "application/json",
          "x-razorpay-event-id": eventId,
          "x-razorpay-signature": createHmac("sha256", SECRET).update(b).digest("hex"),
        },
        payload: b,
      });
    const rowsFor = async (eventId: string) =>
      systemDb
        .select({
          biz: providerEvents.businessId,
          outcome: providerEvents.outcome,
          status: providerEvents.responseStatus,
        })
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.providerKey, "razorpay"),
            eq(providerEvents.providerEventId, eventId),
          ),
        );

    const shared = `evt_${RUN}_shared`;
    const [a, b] = accounts as [{ biz: string; gwa: string }, { biz: string; gwa: string }];
    const r1 = await post(a.gwa, body(1), shared);
    const r2 = await post(b.gwa, body(1), shared);
    const rows = await rowsFor(shared);
    ok(
      "the same event at both webhook URLs answers 200 twice",
      r1.statusCode === 200 && r2.statusCode === 200,
    );
    ok(
      "…and each business applies it (one row each, neither a duplicate)",
      rows.length === 2 &&
        new Set(rows.map((r) => r.biz)).size === 2 &&
        rows.every((r) => r.outcome === "ignored"),
      JSON.stringify(rows),
    );
    ok(
      "…and each row records the status its own delivery got",
      rows.every((r) => r.status === 200),
    );

    await post(a.gwa, body(1), shared);
    ok(
      "a redelivery to the same business is still a duplicate",
      (await rowsFor(shared)).length === 2,
    );

    await recordGatewayWebhookResponse({
      gatewayKey: "razorpay",
      businessId: a.biz,
      providerEventIds: [shared],
      responseStatus: 299,
    });
    const after = await rowsFor(shared);
    ok(
      "stamping a response touches only that business's row",
      after.find((r) => r.biz === a.biz)?.status === 299 &&
        after.find((r) => r.biz === b.biz)?.status === 200,
    );

    const ids = [`evt_${RUN}_s1`, `evt_${RUN}_s2`];
    for (const id of ids) await post(a.gwa, body(2), id);
    const sameSecond = await systemDb
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.providerKey, "razorpay"),
          inArray(providerEvents.providerEventId, ids),
        ),
      );
    ok("two events with the same name and second are both kept", sameSecond.length === 2);

    // A disabled account still settles late refunds and disputes: only charging stops.
    await systemDb
      .update(gatewayAccounts)
      .set({ status: "disabled" })
      .where(eq(gatewayAccounts.publicId, a.gwa));
    const late = `evt_${RUN}_disabled`;
    const rDisabled = await post(a.gwa, body(3), late);
    ok(
      "a disabled account's webhook is still accepted and recorded",
      rDisabled.statusCode === 200 && (await rowsFor(late)).length === 1,
      `${rDisabled.statusCode} ${rDisabled.body}`,
    );

    const orphan = `orphan_${RUN}`;
    const ev = {
      providerEventId: orphan,
      type: "unknown" as const,
      occurredAt: new Date(),
      raw: {},
    };
    const first = await handleProviderEvent("tmtest", ev, {});
    const again = await handleProviderEvent("tmtest", ev, {});
    ok(
      "an event with no business still dedupes",
      first === "ignored" && again === "duplicate",
      `${first}/${again}`,
    );

    await systemDb
      .delete(providerEvents)
      .where(inArray(providerEvents.providerEventId, [shared, ...ids, orphan]));
  } finally {
    await app.close();
  }
}

try {
  await adapterContract();
  await sharedAccount();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ WEBHOOK DEDUP: PASS" : "\n❌ WEBHOOK DEDUP: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
