# NestJS 11 (Express platform)

Files: `src/main.ts`, and `src/billing/` (client, controller, events, a module declaring the controller).

## Bootstrap

```ts
// src/main.ts — inside bootstrap(): keeps req.rawBody next to the parsed body
const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
```

## Client

```ts
// src/billing/billing.client.ts — server-only
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

## Controller

```ts
// src/billing/billing.controller.ts
import {
  BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Post, Redirect, Req,
  UnauthorizedException, UseGuards, type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { tmb, BIZ, APP_URL, PRICES, verifySignature } from "./billing.client";
import { processOnce, type BillingEvent } from "./billing.events";
import { SessionGuard, type AppUser } from "../auth/session.guard"; // replace with the app's auth

@Controller()
export class BillingController {
  @Post("billing/subscribe")
  @UseGuards(SessionGuard)
  @Redirect() // the returned { url, statusCode } wins
  async subscribe(@Req() req: Request & { user: AppUser }, @Body("price") price: string) {
    if (!PRICES.has(price)) throw new BadRequestException("Unknown price");
    const session = await tmb.checkoutSessions.create(BIZ, {
      items: [{ price, quantity: 1 }],
      customer: { email: req.user.email },
      metadata: { app_account_id: req.user.accountId }, // lands on the subscription
      redirect_url: `${APP_URL}/billing/done`, // shows "processing"; the webhook grants access
      cancel_url: `${APP_URL}/pricing`,
    });
    if (!session.url) throw new Error("Billing server has no checkout base URL");
    return { url: session.url, statusCode: HttpStatus.SEE_OTHER }; // create it per click; never log it
  }

  @Post("billing/manage")
  @UseGuards(SessionGuard)
  @Redirect()
  async manage(@Req() req: Request & { user: AppUser }) {
    const cus = req.user.tmbillingCustomerId;
    if (!cus) return { url: "/pricing", statusCode: HttpStatus.SEE_OTHER };
    const portal = await tmb.paymentMethods.createPortalSession(BIZ, cus);
    if (!portal.url) throw new Error("Billing server has no portal base URL");
    return { url: portal.url, statusCode: HttpStatus.SEE_OTHER };
  }

  @Post("webhooks/billing")
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers("tmbilling-signature") sig?: string) {
    if (!req.rawBody || !verifySignature(req.rawBody, sig)) throw new UnauthorizedException();
    await processOnce(JSON.parse(req.rawBody.toString("utf8")) as BillingEvent); // throw → 500 → redelivered
  }
}
```

## Events

```ts
// src/billing/billing.events.ts — adapt to the app's DB layer (TypeORM/Prisma: same two steps)
import { pool } from "../db"; // the app's pg Pool
import { tmb, BIZ } from "./billing.client";

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

- `rawBody: true` needs Nest's built-in body parser. `bodyParser: false`, or a custom
  `app.use(express.json())`, leaves `req.rawBody` undefined and every delivery gets a 401.
- A global auth guard (`APP_GUARD`) also runs on the webhook. Mark that handler public with the
  app's existing decorator (for example `@Public()`), or the delivery gets a 401 or 403.
- On the Fastify platform, use `NestFactory.create<NestFastifyApplication>(AppModule, new
  FastifyAdapter(), { rawBody: true })` and `RawBodyRequest<FastifyRequest>`.
- Submit with a form, not `fetch()`: `fetch` follows the 303 silently instead of navigating.
