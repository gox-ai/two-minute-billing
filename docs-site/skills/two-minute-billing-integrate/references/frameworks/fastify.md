# Fastify 5

Files: `billing/client.ts`, `billing/events.ts`, routes in `routes/billing.ts` (a plugin).

## Client

```ts
// billing/client.ts — server-only
import { createHmac, timingSafeEqual } from "node:crypto";
import { Tmbilling } from "@two-minute-billing/sdk";

export const tmb = new Tmbilling({
  apiKey: process.env.TMBILLING_API_KEY!,
  baseUrl: process.env.TMBILLING_URL,
});
export const BIZ = process.env.TMBILLING_BUSINESS_ID!;
export const APP_URL = process.env.APP_URL!;
export const PRICES = new Set(["pro-monthly-usd", "pro-yearly-usd"]); // what the app sells

export function verifySignature(raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const secret = process.env.TMBILLING_WEBHOOK_SECRET!;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function entitled(sub: string, key: string, required?: number): Promise<boolean> {
  const qs = required === undefined ? "" : `?required=${required}`;
  const res = await fetch(
    `${process.env.TMBILLING_URL}/v1/businesses/${BIZ}/subscriptions/${sub}/entitlements/${encodeURIComponent(key)}/check${qs}`,
    { headers: { Authorization: `Bearer ${process.env.TMBILLING_API_KEY}` } },
  );
  if (!res.ok) throw new Error(`entitlement check failed: ${res.status}`);
  return ((await res.json()) as { entitled: boolean }).entitled; // also: reason, value, used
}
```

## Routes

```ts
// routes/billing.ts
import type { FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { tmb, BIZ, APP_URL, PRICES, verifySignature } from "../billing/client";
import { processOnce, type BillingEvent } from "../billing/events";
import { currentUser } from "../auth"; // replace with the app's auth

export async function billingRoutes(app: FastifyInstance) {
  await app.register(formbody); // the subscribe form posts urlencoded

  app.post<{ Body: { price?: string } }>("/billing/subscribe", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send();
    const price = String(req.body?.price ?? "");
    if (!PRICES.has(price)) return reply.code(400).send("Unknown price");
    const session = await tmb.checkoutSessions.create(BIZ, {
      items: [{ price, quantity: 1 }],
      customer: { email: user.email },
      metadata: { app_account_id: user.accountId }, // lands on the subscription
      redirect_url: `${APP_URL}/billing/done`, // shows "processing"; the webhook grants access
      cancel_url: `${APP_URL}/pricing`,
    });
    if (!session.url) throw new Error("Billing server has no checkout base URL");
    return reply.redirect(session.url, 303); // v5 order: (url, code). Single-use: never log it
  });

  app.post("/billing/manage", async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send();
    if (!user.tmbillingCustomerId) return reply.redirect("/pricing", 303);
    const portal = await tmb.paymentMethods.createPortalSession(BIZ, user.tmbillingCustomerId);
    if (!portal.url) throw new Error("Billing server has no portal base URL");
    return reply.redirect(portal.url, 303);
  });

  // Encapsulated child context: the buffer parser applies only to routes inside it.
  // Do NOT wrap this in fastify-plugin, which would leak the parser to every JSON route.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1_048_576 },
      (_req, body, done) => done(null, body));

    scope.post("/webhooks/billing", async (req, reply) => {
      const raw = req.body as Buffer, sig = req.headers["tmbilling-signature"];
      if (!Buffer.isBuffer(raw) || typeof sig !== "string" || !verifySignature(raw, sig)) {
        return reply.code(401).send();
      }
      await processOnce(JSON.parse(raw.toString("utf8")) as BillingEvent);
      return reply.code(200).send(); // a throw is a 500: the event comes again
    });
  });
}
// app entry: await app.register(billingRoutes);
```

## Events

```ts
// billing/events.ts — adapt the SQL to the app's database layer
import { pool } from "../db"; // the app's pg Pool (or ORM)
import { tmb, BIZ } from "./client";

export interface BillingEvent { id: string; event_type: string; occurred_at: string; content: Record<string, any> }

// Event id (= Tmbilling-Event-Id header) and its effects commit together; a throw rolls both back.
export async function processOnce(e: BillingEvent): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const ins = await db.query("INSERT INTO billing_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [e.id]);
    if (ins.rowCount === 1) {
      // content is a short summary (ids, status, a few fields); fetch the resource for the rest.
      switch (e.event_type) {
        case "subscription_created":
        case "subscription_changed":
        case "subscription_canceled": {
          const sub = await tmb.subscriptions.get(BIZ, e.content.subscription.id);
          // The response carries customer and metadata; the SDK type does not declare them yet.
          const accountId = (sub.metadata as Record<string, string> | null)?.app_account_id; // set at checkout
          if (accountId) {
            await db.query( // an older event never overwrites newer state
              `UPDATE accounts SET tmbilling_customer_id = $2, tmbilling_subscription_id = $3,
                 billing_status = $4, billing_synced_at = $5
               WHERE id = $1 AND (billing_synced_at IS NULL OR billing_synced_at < $5)`,
              [accountId, sub.customer as string, sub.id, sub.status, e.occurred_at]);
          }
          break;
        }
        case "invoice_paid": {
          const inv = await tmb.invoices.get(BIZ, e.content.invoice.id);
          if (inv.status === "paid") {
            // Record the receipt. One-time store: inv.metadata?.order_id (checkout metadata) is the order.
          }
          break;
        }
        case "payment_failed":
          // No fetch: e.content.payment has amount_minor, currency, invoice, code and message.
          break; // show a payment-problem banner with e.content.payment.message
        default:
          console.info(`billing webhook: skipped ${e.event_type}`); // never throw on a new type
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
```

## Gotchas

- Overriding `application/json` is allowed only while the default parser is in place. If the app
  already registered its own JSON parser at the root, this throws `FST_ERR_CTP_ALREADY_PRESENT`;
  call `scope.removeContentTypeParser("application/json")` first in the child scope.
- `fastify-plugin` (`fp`) removes encapsulation. Register the webhook scope as a plain async
  function so other routes keep parsed JSON.
- A `preHandler` auth hook added at the root runs for the webhook too. Exempt the path, or add
  the hook only inside the scope that holds the signed-in routes.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
