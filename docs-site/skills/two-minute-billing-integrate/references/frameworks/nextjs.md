# Next.js (App Router)

Files: `lib/billing.ts` (server-only client), route handlers under `app/api/**/route.ts`.

## Client

```ts
// lib/billing.ts
import "server-only"; // add the `server-only` package: a client import then fails the build
import { createHmac, timingSafeEqual } from "node:crypto";
import { Tmbilling } from "@two-minute-billing/sdk";

export const tmb = new Tmbilling({
  apiKey: process.env.TMBILLING_API_KEY!, // never NEXT_PUBLIC_
  baseUrl: process.env.TMBILLING_URL,
});
export const BIZ = process.env.TMBILLING_BUSINESS_ID!;
export const APP_URL = process.env.APP_URL!;
export const PRICES = new Set(["pro-monthly-usd", "pro-yearly-usd"]); // what the app sells

export function verifySignature(raw: Buffer, header: string | null): boolean {
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
    { headers: { Authorization: `Bearer ${process.env.TMBILLING_API_KEY}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`entitlement check failed: ${res.status}`);
  return ((await res.json()) as { entitled: boolean }).entitled; // also: reason, value, used
}
```

## Subscribe and manage

```ts
// app/api/billing/subscribe/route.ts
import { tmb, BIZ, APP_URL, PRICES } from "@/lib/billing";
import { currentUser } from "@/lib/auth"; // replace with the app's auth

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return new Response(null, { status: 401 });
  const price = String((await request.formData()).get("price") ?? "");
  if (!PRICES.has(price)) return new Response("Unknown price", { status: 400 });
  const session = await tmb.checkoutSessions.create(BIZ, {
    items: [{ price, quantity: 1 }],
    customer: { email: user.email },
    metadata: { app_account_id: user.accountId }, // lands on the subscription
    redirect_url: `${APP_URL}/billing/done`, // shows "processing"; the webhook grants access
    cancel_url: `${APP_URL}/pricing`,
  });
  if (!session.url) throw new Error("Billing server has no checkout base URL");
  return Response.redirect(session.url, 303); // valid 24 h by default: create it per click, never store or log it
}
```

```ts
// app/api/billing/manage/route.ts
import { tmb, BIZ, APP_URL } from "@/lib/billing";
import { currentUser } from "@/lib/auth"; // replace with the app's auth

export async function POST() {
  const user = await currentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!user.tmbillingCustomerId) return Response.redirect(`${APP_URL}/pricing`, 303);
  const portal = await tmb.paymentMethods.createPortalSession(BIZ, user.tmbillingCustomerId);
  if (!portal.url) throw new Error("Billing server has no portal base URL");
  return Response.redirect(portal.url, 303);
}
```

## Webhook

```ts
// app/api/webhooks/billing/route.ts
import { verifySignature } from "@/lib/billing";
import { processOnce, type BillingEvent } from "@/lib/billing-events";

export const runtime = "nodejs"; // node:crypto; the edge runtime does not have it

export async function POST(request: Request) {
  const raw = Buffer.from(await request.arrayBuffer()); // the exact signed bytes
  if (!verifySignature(raw, request.headers.get("tmbilling-signature"))) return new Response(null, { status: 401 });
  await processOnce(JSON.parse(raw.toString("utf8")) as BillingEvent); // a throw is a 500: the event comes again
  return new Response(null, { status: 200 });
}
```

```ts
// lib/billing-events.ts — adapt the SQL to the app's database layer
import { pool } from "@/lib/db"; // the app's pg Pool (or ORM)
import { tmb, BIZ } from "@/lib/billing";

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

Gate features with `await entitled(account.tmbillingSubscriptionId, "seats", seatCount + 1)` in a
server component, route handler or server action, never in client code.

## Gotchas

- The edge runtime has no `node:crypto`; keep `runtime = "nodejs"` on the webhook route.
- Read the body once, with `arrayBuffer()`; a re-serialized `request.json()` is not the signed bytes.
- Auth `middleware.ts` (`proxy.ts` from Next.js 16) must let `/api/webhooks/billing` through:
  exclude it in `matcher`, or the delivery gets a sign-in redirect.
- With `trailingSlash: true`, register the URL with the slash; a redirected POST fails.
- Submit with a plain `<form method="post">`, not `fetch()`: `fetch` follows the 303 silently
  instead of navigating.
