# Express 5 (and 4.17+)

Files: `billing/client.ts`, `billing/events.ts`, routes registered in the app entry (`app.ts`).

The SDK is ESM-only. Find out how the app loads modules before you import it:

- **ESM** (`"type": "module"`, or TypeScript with `module` set to `node16`, `nodenext` or
  `esnext`): `import { Tmbilling } from "@two-minute-billing/sdk"` as below.
- **Plain JavaScript CommonJS** (`require`): load it inside an async init with
  `const { Tmbilling } = await import("@two-minute-billing/sdk")`.
- **TypeScript compiled to CommonJS** (`"module": "commonjs"` in `tsconfig.json`, common in older
  Express apps): `tsc` rewrites `await import()` into `require()`, which fails for an ESM-only
  package. Call the REST API with `fetch` as `patterns.md` shows (the `entitled` helper below is
  already plain `fetch`), or set `module` to `node16` or `nodenext` if the app can move to it.

**Express 4.17 or later** runs this code with one change. Express 4 does not pass a rejected
promise from an async handler to the error handler: the request gets no answer and Node reports
an unhandled rejection. Wrap each async handler so a failure answers 500 and the event comes
again:

```ts
const handle =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
// app.post("/webhooks/billing", express.raw({ … }), handle(async (req, res) => { … }));
```

`express.raw` needs 4.17 or later. `req.body?.…` reads work on both versions.

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
// app.ts
import express from "express";
import { tmb, BIZ, APP_URL, PRICES, verifySignature } from "./billing/client";
import { processOnce, type BillingEvent } from "./billing/events";
import { currentUser } from "./auth"; // replace with the app's auth

const app = express();

// Webhook FIRST: express.raw keeps the exact signed bytes. A global express.json() above it
// would consume the stream.
app.post("/webhooks/billing", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get("Tmbilling-Signature"))) {
    return res.sendStatus(401);
  }
  await processOnce(JSON.parse(req.body.toString("utf8")) as BillingEvent);
  res.sendStatus(200); // a throw above becomes a 500 and the event is delivered again
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.post("/billing/subscribe", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.sendStatus(401);
  const price = String(req.body?.price ?? "");
  if (!PRICES.has(price)) return res.status(400).send("Unknown price");

  const session = await tmb.checkoutSessions.create(BIZ, {
    items: [{ price, quantity: 1 }],
    customer: { email: user.email },
    metadata: { app_account_id: user.accountId }, // lands on the subscription
    redirect_url: `${APP_URL}/billing/done`, // shows "processing"; the webhook grants access
    cancel_url: `${APP_URL}/pricing`,
  });
  if (!session.url) throw new Error("Billing server has no checkout base URL");
  res.redirect(303, session.url); // valid 24 h by default: create it per click, never store or log it
});

app.post("/billing/manage", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.sendStatus(401);
  if (!user.tmbillingCustomerId) return res.redirect(303, "/pricing");
  const portal = await tmb.paymentMethods.createPortalSession(BIZ, user.tmbillingCustomerId);
  if (!portal.url) throw new Error("Billing server has no portal base URL");
  res.redirect(303, portal.url);
});
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
        case "subscription_activated":
        case "subscription_cancel_scheduled":
        case "subscription_scheduled_cancellation_removed":
        case "subscription_reactivated":
        case "subscription_paused":
        case "subscription_resumed":
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

- Order matters: `app.use(express.json())` (or a router that applies it) ahead of the webhook
  route turns `req.body` into an object, and verification fails. The `Buffer.isBuffer` check makes
  that a clean 401.
- Express 5 leaves `req.body` `undefined` when no parser matched; read it with `?.`.
- Express 5 forwards a rejected promise to the error handler; Express 4 needs the `handle`
  wrapper above. Do not catch and answer 200 on a failure: the 500 is what makes the event come
  again.
- CSRF middleware (`csrf-csrf`, `csrf-sync`) must skip `/webhooks/billing`; keep it on the
  subscribe and manage routes.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
