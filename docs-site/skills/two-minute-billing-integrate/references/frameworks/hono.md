# Hono 4

Files: `src/billing.ts` (client + verify), routes on the app in `src/index.ts`. Shown for Node
(`@hono/node-server`); on Workers read config from `c.env` (see Gotchas).

## Client

```ts
// src/billing.ts — server-only
import { Tmbilling } from "@two-minute-billing/sdk";

export const tmb = new Tmbilling({
  apiKey: process.env.TMBILLING_API_KEY!,
  baseUrl: process.env.TMBILLING_URL,
});
export const BIZ = process.env.TMBILLING_BUSINESS_ID!;
export const APP_URL = process.env.APP_URL!;
export const PRICES = new Set(["pro-monthly-usd", "pro-yearly-usd"]); // what the app sells

// Web Crypto runs on every Hono runtime; subtle.verify compares in constant time.
export async function verifySignature(raw: ArrayBuffer, header: string | undefined): Promise<boolean> {
  const hex = header?.startsWith("sha256=") ? header.slice(7) : "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const sig = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(process.env.TMBILLING_WEBHOOK_SECRET!),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, raw);
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
// src/index.ts
import { Hono } from "hono";
import { tmb, BIZ, APP_URL, PRICES, verifySignature } from "./billing";
import { processOnce, type BillingEvent } from "./billing-events"; // below
import { requireUser, type AppUser } from "./auth"; // replace with the app's auth

const app = new Hono<{ Variables: { user: AppUser } }>();

app.post("/billing/subscribe", requireUser, async (c) => {
  const user = c.get("user");
  const price = String((await c.req.parseBody()).price ?? "");
  if (!PRICES.has(price)) return c.text("Unknown price", 400);

  const session = await tmb.checkoutSessions.create(BIZ, {
    items: [{ price, quantity: 1 }],
    customer: { email: user.email },
    metadata: { app_account_id: user.accountId }, // lands on the subscription
    redirect_url: `${APP_URL}/billing/done`, // shows "processing"; the webhook grants access
    cancel_url: `${APP_URL}/pricing`,
  });
  if (!session.url) throw new Error("Billing server has no checkout base URL");
  return c.redirect(session.url, 303); // valid 24 h by default: create it per click, never store or log it
});

app.post("/billing/manage", requireUser, async (c) => {
  const cus = c.get("user").tmbillingCustomerId;
  if (!cus) return c.redirect("/pricing", 303);
  const portal = await tmb.paymentMethods.createPortalSession(BIZ, cus);
  if (!portal.url) throw new Error("Billing server has no portal base URL");
  return c.redirect(portal.url, 303);
});

app.post("/webhooks/billing", async (c) => {
  const raw = await c.req.arrayBuffer(); // the exact signed bytes
  if (!(await verifySignature(raw, c.req.header("Tmbilling-Signature")))) {
    return c.body(null, 401);
  }
  const event = JSON.parse(new TextDecoder().decode(raw)) as BillingEvent;
  await processOnce(event); // throws → 500 → the event is delivered again
  return c.body(null, 200);
});

export default app;
```

`processOnce` (Node + Postgres) in `src/billing-events.ts`:

```ts
import { pool } from "./db"; // the app's pg Pool; adapt to its ORM or D1/Hyperdrive binding
import { tmb, BIZ } from "./billing";

export interface BillingEvent { id: string; event_type: string; occurred_at: string; content: Record<string, any> }

// Event id (= Tmbilling-Event-Id header) and its effects commit together.
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

- Workers have no `process.env`. Build the client per request from `c.env` (or `env(c)` from
  `hono/adapter`) and keep the key in a secret binding, never in `wrangler.toml` vars.
- Read the body with `c.req.arrayBuffer()`. Re-serializing `await c.req.json()` changes the
  bytes, so the signature no longer matches.
- `hono/csrf` checks only form content types, so it protects the subscribe form and lets the JSON
  webhook through. Do not put `requireUser` or a global auth middleware on `/webhooks/billing`.
- `subtle.verify` compares in constant time; never compare hex strings with `===`.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
