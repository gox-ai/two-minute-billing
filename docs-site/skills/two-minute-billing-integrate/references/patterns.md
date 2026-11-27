# Integration code

Code for the two-minute-billing-integrate skill. TypeScript uses `@two-minute-billing/sdk`; adapt the
framework glue (Express, Fastify, Next.js, Hono…) to what the project already uses. Every id
below is a placeholder.

Shared setup, server-side only:

```ts
// billing/client.ts
import { Tmbilling } from "@two-minute-billing/sdk";

export const tmb = new Tmbilling({
  apiKey: process.env.TMBILLING_API_KEY!,
  baseUrl: process.env.TMBILLING_URL,
});
export const BIZ = process.env.TMBILLING_BUSINESS_ID!;
```

For a route the SDK does not cover, call the API with the same headers. A write that the app
retries (a queued job, a timeout) must pass the SAME `idempotencyKey` each time, made from the
action (`seats-${accountId}-${changeId}`); a fresh key per call charges twice on a retry.

```ts
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  const res = await fetch(`${process.env.TMBILLING_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.TMBILLING_API_KEY}`,
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
```

## Checkout and portal

```ts
// POST /billing/subscribe   (signed-in users only)
app.post("/billing/subscribe", requireUser, async (req, res) => {
  const account = req.user.account;
  const session = await tmb.checkoutSessions.create(BIZ, {
    items: [{ price: req.body.price ?? "pro-monthly-usd", quantity: 1 }],
    customer: { email: req.user.email },          // prefills the form
    metadata: { app_account_id: account.id },      // lands on the subscription
    redirect_url: `${process.env.APP_URL}/billing/done`,
    cancel_url: `${process.env.APP_URL}/pricing`,
  });
  res.redirect(303, session.url!);
});

// POST /billing/manage
app.post("/billing/manage", requireUser, async (req, res) => {
  const cus = req.user.account.tmbilling_customer_id;
  if (!cus) return res.redirect(303, "/pricing");
  const portal = await tmb.paymentMethods.createPortalSession(BIZ, cus);
  res.redirect(303, portal.url!);
});
```

- Validate `req.body.price` against the prices the app offers; do not pass user input through.
- Create both links on click; never store or email them, and keep them out of logs. A checkout
  link stays valid until its `expires_at` (24 hours by default). A portal link opens once and
  only within one hour.
- To change an existing subscription with the buyer present, use checkout `mode: "change"` with
  `subscription`. With no buyer present, change the subscription through the API directly.
- `/billing/done` shows "processing" until the webhook arrives; it must not grant access itself.

### Popup or inline (embed.js)

The website must be on the business's allowed list first (`tmb.businesses.embedding.setOrigins`).

```ts
// POST /billing/subscribe-embedded   → JSON, the page opens it
app.post("/billing/subscribe-embedded", requireUser, async (req, res) => {
  const session = await tmb.checkoutSessions.create(BIZ, {
    items: [{ price: req.body.price ?? "pro-monthly-usd", quantity: 1 }], // validate, as above
    customer: { email: req.user.email },
    metadata: { app_account_id: req.user.account.id },
    embed_origin: process.env.APP_ORIGIN!, // e.g. https://app.example.com, on the allowed list
  });
  res.json({ url: session.url });
});

// POST /billing/manage-embedded
app.post("/billing/manage-embedded", requireUser, async (req, res) => {
  const cus = req.user.account.tmbilling_customer_id;
  if (!cus) return res.status(409).json({ error: "no_billing_account" });
  const portal = await tmb.paymentMethods.createPortalSession(BIZ, cus, {
    embed_origin: process.env.APP_ORIGIN!,
  });
  res.json({ url: portal.url });
});

// GET /billing/embed-script → { script_url, script_integrity } for the <script> tag (cache it)
app.get("/billing/embed-script", async (_req, res) => {
  const { script_url, script_integrity } = await tmb.businesses.embedding.get(BIZ);
  res.json({ script_url, script_integrity });
});
```

```html
<script src="{script_url}" integrity="{script_integrity}" crossorigin="anonymous"></script>
<script>
  async function upgrade(price) {
    const { url } = await fetch("/billing/subscribe-embedded", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price }),
    }).then((r) => r.json());
    const checkout = TMB.checkout.open({ url }); // or TMB.checkout.mount("#checkout", { url })
    checkout.on("success", () => location.reload()); // access comes from the webhook
  }
</script>
```

- Events carry ids only; refresh from your server, which trusts the webhook.
- `success` with `paid: false`: the provider still holds the payment. Keep "processing".

## Webhooks

### Verify (Node)

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Hash the **raw** bytes. `JSON.stringify(req.body)` is not what was signed.

- Express: `app.post("/webhooks/billing", express.raw({ type: "application/json" }), handler)`
  — mount it before any global `express.json()`, or capture `rawBody` in `express.json({ verify })`.
- Fastify: a content-type parser with `parseAs: "buffer"` for that route.
- Next.js route handler: `const raw = Buffer.from(await request.arrayBuffer())`.

### Verify (Python, Go)

```python
import hmac, hashlib

def verify(raw_body: bytes, header: str | None, secret: str) -> bool:
    if not header:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)
```

```go
func Verify(rawBody []byte, header, secret string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(rawBody)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(header))
}
```

### Handle

```ts
type BillingEvent = {
  id: string;
  event_type: string;
  occurred_at: string;
  content: any;
  imported?: boolean;
};

app.post("/webhooks/billing", express.raw({ type: "application/json" }), async (req, res) => {
  if (!verify(req.body, req.header("Tmbilling-Signature"), process.env.TMBILLING_WEBHOOK_SECRET!)) {
    return res.sendStatus(401);
  }
  const event: BillingEvent = JSON.parse(req.body.toString("utf8"));

  // Deduplicate: a delivery can repeat. Store event ids in a table with a unique key.
  if (!(await markEventSeen(event.id))) return res.sendStatus(200);
  await handleEvent(event);
  res.sendStatus(200);
});

export async function handleEvent(event: BillingEvent): Promise<void> {
  switch (event.event_type) {
    case "subscription_created":
    case "subscription_changed":
    case "subscription_activated":
    case "subscription_cancel_scheduled":
    case "subscription_scheduled_cancellation_removed":
    case "subscription_reactivated":
    case "subscription_canceled":
    case "subscription_paused":
    case "subscription_resumed": {
      // content.subscription is { id, status }: fetch the subscription for the rest.
      const sub = await tmb.subscriptions.get(BIZ, event.content.subscription.id);
      await syncSubscription(sub, event.occurred_at);
      break;
    }
    case "invoice_paid": {
      const invoice = await tmb.invoices.get(BIZ, event.content.invoice.id);
      if (invoice.status === "paid") await markPaid(invoice);
      break;
    }
    case "payment_failed":
      // content.payment already has amount_minor, currency, invoice, code and message.
      await notifyPaymentProblem(event.content.payment);
      break;
    case "invoice_dunning_exhausted":
    case "invoice_not_paid":
      // Retries ended: ask the customer to pay. Access follows the subscription event
      // that the business's dunning final action sends, not this one.
      await notifyPaymentProblem(event.content.invoice);
      break;
    case "payment_source_expiring":
      // content.payment_source has customer, brand and last4: ask for a new card.
      await notifyPaymentProblem(event.content.payment_source);
      break;
  }
}
```

- Answer `2xx` quickly; move slow work to the app's job queue.
- `content` is a short summary: the id, the status and a few fields per type, listed at
  https://twominutebilling.com/help/developers/webhooks/events.md. Fetch the resource by id for
  anything else. Where the app moves work to a job queue, fetch in the job.
- Order is not guaranteed. Compare timestamps (`occurred_at`) before overwriting newer state.
- `syncSubscription` reads `metadata.app_account_id` (set at checkout) from the fetched
  subscription to find the account, then stores its `customer` (`cus_…`), `id` (`sub_…`) and
  `status`. A subscription with no account (a `tmb trigger` customer, a payment link) is skipped,
  not an error. Access follows `status`: `in_trial`, `active` and `non_renewing` have it;
  `paused` and `cancelled` do not. For `non_renewing`, show "Ends on" with `canceled_at`. The response carries `customer` and `metadata`, but the SDK's `Subscription` type
  does not declare them yet: cast them (`sub.metadata as Record<string, string> | null`).
- `markPaid` acts only on `status: "paid"`. For a one-time purchase, the checkout's `metadata`
  is on the invoice: `invoice.metadata?.order_id` links it to the app's order.

### Register

```ts
const endpoint = await api<{ id: string; signing_secret: string }>("POST", "/v1/webhook_endpoints", {
  url: "https://app.example.com/webhooks/billing",
  business: BIZ,
  event_types: [
    "subscription_created", "subscription_changed", "subscription_canceled", "invoice_paid", "payment_failed",
    "subscription_activated", "subscription_cancel_scheduled", "subscription_scheduled_cancellation_removed",
    "subscription_reactivated", "subscription_paused", "subscription_resumed",
    "invoice_dunning_exhausted", "invoice_not_paid", "payment_source_expiring",
  ],
});
```

Every name in `event_types` must be a real event type, or the call answers `400`. Omit the field
to receive every type. `signing_secret` is returned once: have the user store it as
`TMBILLING_WEBHOOK_SECRET`, and do not print it. Rotate with
`POST /v1/webhook_endpoints/{id}/rotate_secret`, accepting both secrets until old deliveries drain.

### Catch up on missed events

Run after downtime, or nightly. Same handler, same dedupe, so an event already handled is skipped.

```ts
type EventPage = { data: BillingEventRow[]; has_more: boolean; next_cursor: string | null };
type BillingEventRow = { id: string; event_type: string; occurred_at: string; content: any; imported?: boolean };

export async function catchUp(since: Date, handle: (e: BillingEventRow) => Promise<void>) {
  let after: string | undefined;
  for (;;) {
    const q = new URLSearchParams({
      occurred_after: since.toISOString(),
      "sort_by[asc]": "occurred_at",
      limit: "100",
    });
    if (after) q.set("starting_after", after);
    const page = await api<EventPage>("GET", `/v1/businesses/${BIZ}/events?${q}`);
    for (const event of page.data) {
      if (event.imported) continue; // history from a migration
      if (await markEventSeen(event.id)) await handle(event);
    }
    if (!page.has_more || page.data.length === 0) return;
    after = page.next_cursor ?? page.data[page.data.length - 1]!.id;
  }
}
```

Pass `handleEvent` from the webhook module as `handle`.

## Cancel and seats from the app

```ts
// Cancel at the term end. Preview first; always send cancel_option.
const sub = account.tmbilling_subscription_id;
const preview = await api<{ net_collect_minor: number; net_refund_minor: number; warnings: string[] }>(
  "POST",
  `/v1/businesses/${BIZ}/subscriptions/${sub}/cancel_estimate`,
  { cancel_option: "end_of_term" },
); // show preview to the user, then cancel on their yes
await api("POST", `/v1/businesses/${BIZ}/subscriptions/${sub}/cancel`, { cancel_option: "end_of_term" });
// subscription_cancel_scheduled follows; the status is non_renewing until canceled_at.

// Undo it while the term runs.
await api("POST", `/v1/businesses/${BIZ}/subscriptions/${sub}/reactivate`, {});

// One more seat: preview, show the amount, then apply the same change.
const current = await api<{ items: Array<{ id: string; price: string; quantity: number }> }>(
  "GET",
  `/v1/businesses/${BIZ}/subscriptions/${sub}`,
);
const seatItem = current.items.find((i) => i.price === "team-monthly-usd")!;
const changes = [{ item: seatItem.id, quantity: seatCount + 1 }];
const est = await api<{ quote: string; priced_at: string }>(
  "POST",
  `/v1/businesses/${BIZ}/subscriptions/${sub}/estimate`,
  { changes },
);
await api("POST", `/v1/businesses/${BIZ}/subscriptions/${sub}/change`, {
  changes,
  quote: est.quote,
  priced_at: est.priced_at,
  invoice_immediately: true,
});
```

- A seat add can answer `402` with `pending_change` (`apply_when_paid`): the seat count did not
  change yet. See "Errors and retries" in SKILL.md.

## Entitlements

Define features once, grant them on plans, and ask at the point of the action.

```ts
// once, in the catalog script
await api("POST", `/v1/businesses/${BIZ}/features`, { key: "seats", name: "Seats", type: "quota" });
await api("POST", `/v1/businesses/${BIZ}/products/pro/entitlements`, { feature: "seats", value: "25" });

// at the point of the action
const check = await api<{ entitled: boolean; reason: string }>(
  "GET",
  `/v1/businesses/${BIZ}/subscriptions/${account.tmbilling_subscription_id}/entitlements/seats/check?required=${seatCount + 1}`,
);
if (!check.entitled) throw new Error("Your plan does not include more seats.");
```

Feature types: `switch` (on/off), `quota` (a ceiling), `meter` (consumed over a window). Gate on the
feature key, never on the plan id. Cache
`GET /v1/businesses/{biz}/subscriptions/{sub}/entitlements` per session for menus and badges.

## Errors

The SDK throws `TmbillingError` with `status`, `type`, `message` and the full `body`. Retry
`rate_limit_error` and network failures with the **same** idempotency key (pass
`{ idempotencyKey }`); do not retry `invalid_request_error`. A test key asking for a live
business gets `404`, by design.
