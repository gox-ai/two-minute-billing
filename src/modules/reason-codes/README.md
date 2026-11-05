# reason-codes

Merchant-managed lists of the reasons an operator can pick from when performing an
action, offered from **Settings → Reason Codes**. Recording a stable code
instead of free prose is what makes churn and refund reporting groupable.

## Model

One table, `reason_codes` (`db/schema/reason-codes.ts`), business-scoped and
org-isolated by RLS:

| column | meaning |
|---|---|
| `applies_to` | which action the reason is offered for — `subscription_cancellation` \| `refund` |
| `code` | stable machine value persisted on the entity; unique per (business, applies_to) |
| `label` | what the operator sees |
| `position` | order in the picker |
| `enabled` | soft-disable: stops being offered, existing records still render its label |

## The central design decision: definitions, not constraints

The chosen value keeps living on the entity it describes as **plain text** —
`subscriptions.cancel_reason_code`, `refunds.reason`. It is deliberately **not a
foreign key**:

- the API has always accepted an arbitrary string there, and importers carry codes
  from other systems that were never defined here;
- a historical record must not change meaning — or break — because someone later
  renamed or deleted a reason code.

So this module drives what a picker **offers**. It never validates what is stored.
Deleting a code is therefore safe: records already carrying it keep their value and
the picker simply stops offering it.

## Fallback defaults

`resolveOfferedReasons()` returns the business's enabled codes in order, or
`DEFAULT_CANCELLATION_REASONS` (seven built-in reasons) when it has defined none,
along with `isFallback` so the UI can say the list is not configured yet.

These are a **fallback, not a seed**. Seeding rows would mean an existing business
silently gained editable config it never asked for, and a business that deliberately
deleted every code would have them resurrected. Note the copy in
`dashboard/lib/reason-code-defaults.ts` — it exists only so the settings page can grey
them out without a round trip, and must stay in sync with the constant here.

## Not covered

`credit_notes.reason_code` is a **fixed protocol enum**
(`write_off | subscription_change | subscription_cancellation | chargeback | other`)
that the engine itself branches on. It is not merchant-editable and is not
represented in this module. Invoice void has no reason column at all, so there is no
reason surface for it.

## API

```
POST   /v1/businesses/:biz/reason_codes            { applies_to, code, label, position?, enabled? }
GET    /v1/businesses/:biz/reason_codes            ?applies_to=…
GET    /v1/businesses/:biz/reason_codes            ?applies_to=…&offered=true → picker list + is_fallback
PATCH  /v1/businesses/:biz/reason_codes/:rsn       { label?, position?, enabled? }
DELETE /v1/businesses/:biz/reason_codes/:rsn       204
```

## Consumers

- `dashboard/.../settings/reason-codes` — manage the lists.
- `CancelSubscriptionDialog` (`components/subscriptions/lifecycle-dialogs.tsx`) — takes
  the offered list as its `reasons` prop; falls back to its built-in constant when the
  prop is absent, so a caller that doesn't pass it behaves as it did before this module.

## Changelog

- **2026-07-29** — created. Table + RLS (`0128_reason_codes.sql`), service, routes,
  settings page, and the cancel dialog switched from a hard-coded list to the managed one.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-11-02 (0481)** — `billing_rules_config.required_reasons` makes a reason mandatory per action: cancel (`cancel_reason_code`), invoice void (`void_invoice` — free text, now stored as `invoices.void_reason_code`), credit note (`reason_code`) and refund (`reason`). The routes refuse with 400; system-driven cancels and the buyer portal are not covered. The codes themselves are still never validated. Gate: `verify:settings-billing-rules`.
