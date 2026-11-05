# emails — customer billing email outbox

> Source: `src/modules/emails/` · Routes: `src/api/email-routes.ts` · Schema: `db/schema/emails.ts` (`email_messages`, `email_templates`) + `businesses.email_config` / `smtp_config` / `smtp_credentials_enc`
> Adapter: `src/providers/mailer/` · Layer: foundation

## Purpose
Sends customer-facing billing emails (invoice issued, payment receipt, failed payment, non-payment
cancellation) — the Tier-1 gap M13 (billing was previously silent). Mirrors the webhook outbox: an
event sink renders + enqueues a message row in the **same transaction** as the source event, and the
billing clock delivers it asynchronously with retry/backoff through a provider-agnostic mailer adapter.

## Opt-in
Emails are **off by default**. A business sends nothing until `businesses.email_config.enabled = true`
(`resolveEmailConfig`), so importing/existing businesses stay silent. Individual types can be turned off
via `email_config.types.<type> = false`.

## Responsibilities
- `enqueueEmails(tx, event)` — event sink (registered via `registerEventSink`); maps a billing event to
  an email type + recipient, gates on the business opt-in + a resolvable customer email, renders the
  built-in template, and inserts a `pending` `email_messages` row.
- `deliverPendingEmails(now)` — clock-driven delivery (wired into `runBillingClockTick` next to webhook
  `deliverPending`): atomic per-row claim, send via the mailer adapter, mark sent / retry with backoff
  (≤6 attempts).
- Read + resend API (`service.ts`): list / get / resend for the dashboard Emails log.

## The 33 types, and what fires them
`EMAIL_TYPES` (config.ts) splits three ways, and the split decides where a new type's logic goes:

- **Event-driven (24)** — `enqueueEmails` maps a billing event to a type in `emailTypeForEvent`.
  Invoicing and payments (10): `invoice_generated → invoice_issued` ·
  `invoice_payment_due → invoice_overdue` · `payment_succeeded → payment_receipt` ·
  `payment_failed → payment_failed` ·
  `payment_authentication_required → payment_authentication_required` · `dunning_retry` ·
  `refund_created → refund_initiated | refund_issued` (split on the refund's status — see
  below) · `credit_note_created → credit_note_issued` ·
  `credit_note_allocated → credit_note_applied`. Subscription lifecycle (7): the six
  `subscription_*` events, plus the non-payment split below. Trial lifecycle (3):
  `trial_started`, `trial_expired`, `trial_extended`. Payment method (4):
  `payment_source_expiring|expired → card_expiring|card_expired` (or, when the sweep's
  `expiry_reason` says the MANDATE lapsed rather than the printed card, the rail-neutral
  `mandate_expired`), plus `payment_method_invalid` for an instrument refused in a way that
  will not fix itself. Unmapped events are a no-op. `subscription_canceled` splits on
  reason: dunning (`not_paid`/`no_card`) → `subscription_canceled_nonpayment`, anything
  else → `subscription_canceled`.
- **Reminders (7)** — `trial_ending`, `renewal_reminder`, `cancellation_reminder`,
  `payment_due_reminder`, `pause_reminder`, `resume_reminder` and
  `pre_debit_notification`, from the time-relative events `runRemindersPass` emits (see
  `src/modules/subscriptions/README.md`). They arrive through the same event sink; the reminder pass
  owns *when*, this module owns *what*. Lead times are published by `GET …/emails/reminders` from
  `REMINDER_LEAD_DAYS`, so a screen never has to say "a few days before".
- **Ad-hoc (4)** — `invoice_sent`, `payment_request`, `payment_method_request`, `credit_note_sent`.
  Never fired by the engine; see `adhoc-service.ts`.

⚠️ **A refund the provider ACCEPTED is not a refund the customer has received.** `refund_created`
fires the moment the rail takes the request, and on cards that is 5–10 working days before the money
lands. The event used to be emitted with a hardcoded `status: 'succeeded'` — while the `refunds` row
beside it was written `pending` and its transaction `in_progress` — so the customer was told their
refund "has been issued" a week early, which is the one claim a billing system cannot walk back.
The event now carries the real status and `emailTypeForEvent` splits on it: `pending` →
`refund_initiated` (promises only that it has started), anything else → `refund_issued`. Only an
explicit `pending` takes the softer path, so a settled refund can never be downgraded.
Pinned in `test/unit/email-routing.test.ts`.

The settlement half is `refund_settled` → `refund_issued`. A refund that settles synchronously
never raises it, so the customer gets exactly one mail either way: `refund_issued` at acceptance, or
`refund_initiated` then `refund_issued`. Proven end to end by `pnpm verify:refund-settlement`.

⚠️ **Adding an email type touches FIVE lists and only two are compiler-enforced.**
`DEFAULT_TEMPLATES` and `TEMPLATE_VARS` are exhaustive `Record<EmailType, …>` so `tsc` names them.
The OpenAPI enum is caught by `mandate.test.ts`. The dashboard's `lib/email-types.ts` is typed
`key: string` and is caught by nothing. And the **recipient/vars switch in `outbox.ts`** is caught by
nothing either — a missing `case` there means `emailTypeForEvent` names the type, no recipient
resolves, and the mail is silently never enqueued. `refund_initiated` shipped in exactly that state
until `verify:refund-settlement` measured it.

⚠️ **The enriched event payload is not the payload you emitted.** `buildEventContent` replaces the
thin resource stub with a full snapshot, and the snapshot renames fields — a cancellation's `reason`
becomes `cancel_reason`. Reading only the pre-enrichment name meant **every real dunning
cancellation sent no email at all** while the unit path looked fine. `cancelReasonOf()` reads both.
Anything keyed off event `data` must survive enrichment; reminder occurrence keys live at the top
level for the same reason.

**`suppress_email` — mail an event without mailing.** `emailTypeForEvent` maps purely off the event
TYPE, so nothing could say "this one occurrence should notify a webhook subscriber but not the
customer" — the only lever a source had was withholding the event entirely, which silenced the
webhook along with the mail (the mandate-expiry backlog cutover in `payment-methods/sweep.ts` did
exactly that, until F-45's follow-up). A source stamps `suppress_email: true` TOP-LEVEL on the emitted
envelope (survives `events/content.ts` replacing the nested resource, same as `expiry_reason`);
`enqueueEmails` checks it before resolving a recipient at all and returns without enqueueing, while
the event itself — and therefore the webhook — still fires. Nothing else sets this key today; it is a
lever, not a policy, and using it to re-silence something new is a decision for whoever adds it.

## Ad-hoc sends (`adhoc-service.ts`)
`POST /v1/businesses/:biz/emails/send` — the operator picks a type and a record, we render and send
immediately (not through the outbox: they are watching). Recorded like any other message, terminal,
never retried by the clock.

**Deliberately NOT gated on `email_config.enabled`.** That flag governs automatic engine mail; an
operator who clicked Send has already decided. It will look like a missing gate — it is not.

## Mailer adapter (`src/providers/mailer/`)
Engine never talks to a transport directly (same rule as payment providers). Resolution order, in
`mailer-resolver.ts`:

1. **A `setMailer()` test override** — never bypassed, or a verify run would open real sockets for
   any business that happens to have a transport configured.
2. **The business's own SES settings** (`ses_config.enabled` + region + access key + credentials).
3. **The business's own SMTP settings** (`smtp_config.enabled` + host + port + credentials).
4. **Nothing.** A business with neither gets a `NoTransportMailer` that refuses the send.

(2) and (3) are mutually exclusive in the database (`businesses_mail_transport_ck`), so their order
is a formality — fixed and documented anyway, because a row predating that constraint must still
resolve to the *same* transport on every tick.

**A business brings its own transport or its mail does not go out.** There is deliberately no
fall-through to `MAILER_PROVIDER` for customer mail: the platform relay would send from the wrong
domain, fail the merchant's own SPF/DKIM, and spend platform sending reputation on someone else's
mail — while reporting success. `getMailer()` is reached only through `resolveMailer(null)`, which
carries **platform** mail belonging to no tenant: operator invites and password resets in
`src/modules/auth/service.ts`.

`SmtpMailer` (nodemailer) and `SesMailer` (SESv2 API) are both pooled and cached **per business**,
keyed by a hash of the settings that includes the transport kind, so saving a corrected password
takes effect on the next send rather than the next restart and switching SMTP↔SES can never collide
in the cache. A business whose credentials fail to decrypt — or which stored half a credential —
falls back to (4) with a warning rather than throwing: one tenant with a stale key must not stall
the shared billing clock.

**Which SES?** SES is reachable two ways, and both are supported: through `SmtpMailer` at
`email-smtp.<region>.amazonaws.com` with SES SMTP credentials, or through `SesMailer` over the
SESv2 API. Prefer the API — it takes an IAM key instead of a derived long-lived password, returns a
typed error taxonomy instead of a reply code, works where outbound `:587` is blocked, and can report
account status without sending. The header of `ses.ts` has the full rationale.

### `sent` is not a delivery claim — read `transport` with it
The console sink logs a message and the outbox then marks the row `sent`, because from the outbox's
point of view the transport accepted it and there is nothing to retry. **`email_messages.transport`
records which transport actually carried it** (`console` | `smtp` | `esp`, or NULL for rows written
before the column existed). The dashboard reads the two together: a `sent` row on `console` renders
neutral and says "Console — not delivered", and Settings → Email notifications shows a warning banner
whenever sending is on but nothing is being delivered. `GET …/emails/smtp` exposes the same fact as
`effective_transport` + `delivers`.

### `bounced` vs `failed` — and what we still cannot see
A relay that answers **5xx** will answer 5xx again. Retrying "no such mailbox" six times over six
hours achieves nothing and buries the reason under "gave up after 6 attempts", so a permanent
refusal is **terminal on the first attempt**, as `bounced`.

The two terminal failures are deliberately distinct, because the action differs:

| status | means | whose problem |
|---|---|---|
| `bounced` | the relay refused **this recipient** (5xx naming the address), never retried | the merchant's data — fix the address |
| `failed` | retries exhausted, last word inconclusive (relay down, timeout, sender refused) | usually ours — check the relay and the From address |

⚠️ **A 5xx is only a bounce when the relay refused a RECIPIENT.** `classifySmtpError` reads
nodemailer's `rejected` list to tell the two apart, rather than matching on a relay's
wording. The case that forced this: an unverified From domain answers
`550 … not authorized to send emails from <domain>` at the DATA stage with no rejected
recipient, and treating it as permanent was wrong twice — it marked the CUSTOMER's address
bounced when the customer was fine, and it discarded the whole queue the moment a merchant
saved a From address their relay had not verified. It is transient now, for the same
reason `EAUTH` is: the fix is a setting, and the mail must still be queued when it lands.

Classification lives in the **adapter**, not the engine: `MailerSendError { permanent, code }` in
`providers/mailer/types.ts`, thrown by `SmtpMailer` via `classifySmtpError`. The engine may not know
what an SMTP reply code is (same rule as payment providers), and an adapter that throws a plain
`Error` is treated as **transient** — the safe default, since retrying a permanent failure wastes six
attempts but giving up on a transient one loses the mail.

Two judgement calls worth not re-litigating:
- **`EAUTH` is transient** even though it is usually a 535. Bad credentials are a misconfiguration the
  merchant will fix, and the mail must still be queued when they do; marking it bounced would
  silently discard every invoice sent during a password typo.
- Both directions are asserted (`verify:email-transport`): a sink that refuses at RCPT TO with `550`
  produces a terminal `bounced` row after **one** attempt, and one that answers `451` leaves the row
  `pending` with a retry scheduled. The pair is what stops a classifier stuck on either value from
  passing.

⚠️ **This is only the SYNCHRONOUS half of bounce handling, and the log does not pretend otherwise.**
It catches refusals that happen *during the SMTP conversation*. A relay that accepts a message and
bounces it minutes later (the common case for a real mailbox that is full or disabled) sends a DSN to
the return-path, which nothing here reads — so such a message stays `sent`. Closing that needs either
an **ESP adapter with delivery webhooks** (`esp` is still a stub) or an **inbound DSN mailbox parser**;
a generic SMTP relay has no callback to give us. Complaints (FBL/spam reports) are the same story.
Tracked in `docs/PROGRESS.md`.

### SMTP settings
Transport (`smtp_config`: enabled, host, port, encryption, username) is stored separately from sender
IDENTITY (`email_config`: fromName, fromAddress, replyTo, cc, bcc, subjectPrefix) — the merchant
chooses the identity, the relay decides whether it will authorise it. The password lives in `smtp_credentials_enc`, in the same
AES-GCM envelope as gateway credentials, so `pnpm gateway:rotate-credentials` covers it too. It is
never returned by any route; reads report `password_configured` only. On write, `password` is
tri-state: **absent keeps** the stored one, `''` clears it, a value replaces it — collapsing absent
and empty would wipe the credential every time someone edited the port.

`encryption` is `tls` | `starttls` | `none` rather than a `secure` boolean: `starttls` sets
nodemailer's `requireTLS`, without which a server that omits STARTTLS is silently downgraded to
plaintext.

### One sender resolver, because four copies of the rule disagreed
`resolveSender(cfg)` in `config.ts` is the single source of From / Reply-To / CC / BCC, and
`applySubjectPrefix(cfg, subject)` of the prefix. The `fromX || MAIL_FROM_X` fallback used to be
open-coded in three send paths plus the settings view; **outbox, adhoc-service, sendTestEmail and
`view()` all now call the same function**, so a new field like `cc` cannot reach two senders out of
three. The settings screen used to invent its own version of that fallback and got it wrong twice,
in ways typecheck and `verify:ui` cannot see because a wrong sentence is still a valid sentence:

- it told merchants the From name "defaults to the business name" and put `b.name` in the
  placeholder — the engine has only ever read `MAIL_FROM_NAME`;
- it said a blank Reply-to "uses the support email from Business profile", and linked there. Nothing
  in the mail path reads `support_email`: `cfg.replyTo` goes straight through and the mailer omits
  the header when it is null, so the link sent people to configure a field that was never used.

So `GET …/emails/smtp` returns `effective_from_address` / `effective_from_name` / `from_source` and
the screen renders those. **A settings screen may only state a default it can read** — see the
`default_unbilled_on_cancel` incident in `docs/PROGRESS.md` for the same failure with teeth. The
same rule produced `GET …/emails/reminders`: the three reminder lead times are module constants, and
the hub prints them (`configurable: false`, so no input is offered) rather than saying "a few days".

### CC / BCC / subject prefix
`email_config.cc`, `.bcc` (≤10 each) and `.subjectPrefix` (≤40 chars) apply to **every** send —
automatic, ad-hoc and test. Three things about them are load-bearing:

- **BCC must not leak.** It is an extra envelope recipient with no header; `verify:email-transport`
  asserts that against a real SMTP conversation — the bcc address appears in `RCPT TO` and appears
  *nowhere* in the DATA body. Checking the object we handed `send()` would prove nothing.
- **An empty list must emit no header.** nodemailer renders `Cc: ` for `[]`, and an empty header is
  not the same as an absent one to every relay, so `smtp.ts` maps empty → `undefined`.
- **The prefix is applied at ENQUEUE, not at delivery.** `email_messages.subject` is therefore
  exactly what went out, which is what support reads to answer "what did we send this customer?" —
  and a resend re-delivers that same row, so applying it at send time meant one row could go out
  twice with different subjects while the log showed neither. Delivery deliberately does not
  re-apply it (that would stack `[Fernhill] [Fernhill] …`); both are asserted in `verify:emails`.

The cap is enforced **twice on purpose**: the PATCH zod rejects an over-long list loudly, and
`resolveEmailConfig` truncates whatever is already stored, so a row written before the cap existed
cannot fan one invoice out to hundreds of recipients. CC is also de-duplicated case-insensitively —
two spellings of one mailbox would otherwise put two copies of every invoice in it.

## Templates (`email_templates`)
Per-business overrides of the built-ins, **sparse on purpose**: a row exists only for a type a
merchant edited, everything else renders from `DEFAULT_TEMPLATES` in `templates.ts`. So an empty table
behaves exactly as the engine did before the table existed, and improving a built-in still reaches
every business that never customised it. The row's existence *is* the "customised" flag, which is why
reset-to-default is a `DELETE`.

Editable: subject, heading, body, `footer`, and the layout — button text (`cta_label`, only on
types with a button; the URL stays engine-built), `show_facts`, and `block_order` (a permutation of
`body`/`action`/`facts`/`footer`; logo + heading stay first, the letterhead last).
`templateCapabilities` says which layout controls a type can use, so the editor never shows a dead one.

**One footer, three levels** (`resolveFooter`): the template's own `footer`, else the business
footer (`email_config.footerNote`, Sender settings, common variables only — checked at the API),
else `DEFAULT_FOOTER` ("Thanks, {{businessName}} team"). Built-ins carry no footer of their own,
so every one ends on the business's.

**Attachments are per email type** (`email_config.attachments`, `attachmentRule`), only for the types
in `EMAIL_DOCUMENT`: attach the PDF (default on), skip it for a zero-value invoice
(`ZERO_VALUE_PDF_TYPES`), or don't send at all for one (`ZERO_VALUE_SEND_TYPES`, enqueue-time, no
row). Business config, so changing it never creates a template override. Replaced the business-wide
`attachDocumentPdf` (0301 carried an OFF onto every document type).

**Template language** (`template-lang.ts`): `{{var}}`, `{{var | default: "text"}}`,
`{{#if var}}…{{else}}…{{/if}}`, `{{#unless var}}…{{/unless}}`. Sections test presence only. Body
render order is **sanitise → sections → sanitise → fill (escaped)** — never fill before sanitising, or a
customer's name could smuggle markup the sanitiser then blesses. A section marker alone in its
paragraph/line wraps whole paragraphs and leaves no empty one behind when hidden.

`checkTemplate` runs on save (errors → 400: unreadable syntax, unclosed sections, a variable the type
never has, a section straddling formatting) and on every preview (reported as `issues`, never thrown).
A sometimes-empty variable used bare, without a fallback or an `{{#if}}`, is a **warning**. Render stays
lenient, so a stored row that predates the checks still sends as before.

`TEMPLATE_VARS` records which merge variables each type actually populates, read off
`resolveRecipient` rather than guessed, and flags the conditional ones. `VAR_LABELS` names them for the
editor; `SAMPLE_RENDER_VARS` must cover every advertised key, or a preview renders a hole.

## Data model
`db/schema/emails.ts` — `email_messages` (public_id `em_…`, business/customer, source `event_id`, type,
to, subject, body_html/text, status pending|sent|failed|**bounced**|skipped, attempts,
next_attempt_at, `body_removed_at`). Org-scoped
RLS. `email_messages.transport` records which relay actually carried each row
(`console|smtp|esp|ses`, NULL for rows written before the column existed — read it *with* `status`).

`businesses` holds the settings: `email_config` jsonb (the opt-in and sender identity), and the two
transports — `smtp_config` + `smtp_credentials_enc`, and `ses_config` + `ses_credentials_enc`. Each
pair splits non-secret from secret so a settings read is never a decrypt.
`businesses_mail_transport_ck` forbids both transports being enabled at once.

## Routes
Beyond the log (`GET /emails`, `GET /emails/:id`, `POST /emails/:id/resend`):

| Route | Purpose |
|---|---|
| `GET …/emails/activity` | Send counts over `?window_days=` (default 30, max 365). `delivered`/`not_delivered` and `failed`/`bounced` are separate figures, never summed — see below |
| `GET …/emails/reminders` | Lead time in days for the three reminders. `configurable: false` — deployment constants, so a UI must render them read-only |
| `GET/PATCH …/emails/smtp` | Per-business transport settings; password never returned. GET also reports `effective_from_address` / `effective_from_name` / `from_source` — the From header the engine will actually produce |
| `POST …/emails/smtp/test-connection` | Handshake + auth, sends nothing. A refusal is `ok:false` with a 200 — the diagnosis is the result, not an API error |
| `GET/PATCH …/emails/ses` | Per-business SES settings; secret key never returned (`secret_configured`), access key id IS returned because it identifies rather than authenticates. Saving with `enabled:true` switches SMTP off |
| `POST …/emails/ses/test-connection` | `GetAccount` — verifies credentials and returns `status` (sandbox, sending paused, quota). Sends nothing. Same `ok:false`-with-a-200 convention |
| `POST …/emails/test` | Render one type with sample data and send it now, bypassing the outbox. Recorded with a `[Test]` subject and no customer |
| `GET …/emails/templates` | Every type, built-ins included, each flagged `customized` |
| `GET/PUT/DELETE …/emails/templates/:type` | Read / override / reset one template |
| `POST …/emails/templates/:type/preview` | Render with sample data; accepts a partial draft so the editor previews unsaved edits |

## Verify
- `pnpm verify:emails` (14 checks) — paid invoice enqueues a rendered `payment_receipt` (+
  `invoice_issued`), `deliverPendingEmails` sends it, and an email-disabled business enqueues
  nothing. Also the subject prefix + CC/BCC through the real enqueue→deliver path: the prefix lands
  in the STORED subject, delivery does not stack a second copy, and the row is unchanged by sending.
- `pnpm verify:email-transport` (57 checks) — credential encryption round-trip, the password
  tri-state, the DB CHECK, per-business resolution and pooling, `transport` recorded on both success
  and failure, and **a real SMTP conversation against an in-process sink server** (a mocked transport
  would pass whether or not the adapter speaks SMTP at all) — including that CC is disclosed in the
  headers while **BCC appears only in the envelope**, and that an empty list emits no header. Also permanent-vs-transient
  classification driven through sinks that refuse at RCPT TO with `550` and `451`: the first goes
  terminal `bounced` after one attempt, the second stays `pending` and rescheduled.
- `pnpm verify:ses-transport` (48 checks) — the SES adapter against **a local server speaking the
  SESv2 wire protocol**, so a signed `SendEmail` really is formed (the SigV4 `Authorization` header
  is asserted) rather than a mock returning what it was told. Every OutboundEmail field is checked on
  the wire — CC and BCC stay in their own fields, empty lists are omitted rather than sent as `[]`,
  the idempotency key rides as `X-Entity-Ref-ID` — plus the full permanence table (nine SES error
  names, only a suppression-list `MessageRejected` permanent), RFC 5322/2047 From formatting, and
  per-business resolution: SES over SMTP, fallback when a secret is missing, pooling, rotation and
  cross-transport cache switching. No database and no network.
- `pnpm verify:email-events` (39 checks) — every event→email mapping, driven through real billing
  paths across two customers so a resolver reading the wrong table lands mail on the wrong person.
  Asserts no `always: true` variable renders blank (with a negative control proving the check can
  fail) and that no ISO timestamp reaches rendered mail.
- `pnpm verify:email-adhoc` (97 checks) — the four operator sends, the deliberate non-gate, missing
  records rejected rather than half-filled, and template overrides honoured.
- `pnpm verify:email-reminders` (27 checks) — lives with the reminder pass; proves per-occurrence
  dedup (fires term 1, silent on a re-tick, fires term 2).
- `pnpm verify:email-templates` (31 checks) — sparse-store semantics, upsert-in-place, reset-as-delete,
  cross-business isolation, preview-without-saving, and that an override actually reaches the send
  path. It is what caught the unescaped-template-body hole.

## Changelog
- **2026-11-05** — Account emails share one layout (`renderAccountLayout` in `templates.ts`):
  sign-up, sign-up invite, existing-account notice, password reset, both team invites and every
  account-security notice. White card, logo, brand-hue button, preview text, a copy-the-link
  fallback under link buttons, a footer with the reason and the support address; a red bar only
  on alerts that need action (`mfa_failed_attempts`, `two_factor_reset_requested`). Who signs
  them is `accountBrand()` (`account-brand.ts`): cloud is "Two Minute Billing" with
  `dashboard/public/brand/email-logo.png`; self-hosted is `MAIL_FROM_NAME`, no logo. Every
  renderer takes an optional `brand` for tests. Cover: `test/unit/account-email-layout.test.ts`.
- **2026-11-04 (0498)** — `renderMembershipInviteEmail`: the invite for an address that already
  has an account. It links to the signed-in `/invitations` page and carries no token. Test-mode
  recipients (`isTeamAddress`) count accepted members only. Cover: `test/unit/membership-invite-email.test.ts`.
- **2026-11-05** — The portal sign-in code is sent by the `portal_sign_in_code_send` job, not in
  the request (`sendQueuedSignInCode`); it skips a code that was used, replaced or expired.
- **2026-11-04** — Email buttons open the portal on their task: "Pay now" on that invoice,
  "Change payment method" on the add-card form (`blocksFor` action `kind`, `emailPortalLink(…,
  action)`). Behind the click-to-continue page, so a mail scanner cannot spend the link. Merchant
  URLs are unchanged.
- **2026-11-03** — `portal_sign_in_code`, the first SYSTEM email type (`SYSTEM_EMAIL_TYPES`):
  sent at once when a customer asks for a portal sign-in code (`sign-in-code.ts`), through the
  business's transport, respecting suppression and test mode; never an automatic toggle, never ad
  hoc. The logged row masks the code. Its template is editable; a save without `{{code}}` is refused.
- **2026-11-03** — `customerCopies` (contact-copies.ts): document emails (`EMAIL_DOCUMENT` types:
  invoices, receipts, payment notices, credit notes) also CC `customers.billing_cc_emails` and BCC
  `billing_bcc_emails` (0486). BCC is stored on `email_messages.bcc_addresses` at enqueue, checked
  for suppression and test mode at delivery, and drops anyone already in To or CC. Outbox and
  ad-hoc paths.
- **2026-11-02** — Three reminder types: `payment_due_reminder` (`invoice_payment_due_reminder`; only an open invoice that is not auto-collected, re-checked with `isPayableOfflineInvoice` at enqueue; Pay now; stale when voided), `pause_reminder` and `resume_reminder` (`subscription_pause_reminder` / `_resume_reminder`). `payment_source_expiry_reminder` (card lead days) maps to `card_expiring`, so its switch governs both. `email_config.linkTarget` (`portal` default | `merchant_url`) + `merchantUrl` (http/https): with a merchant URL, `{{portalUrl}}` and the button go there as typed and no portal session is minted (outbox and ad-hoc). The portal links carry no query parameter, so nothing is appended.
- **2026-10-25** — SMTP and SES saves write `mail_transport.smtp.update` / `mail_transport.ses.update` audit rows in the save's tx: changed config fields, and the password / access key id / secret access key as `changed` or `cleared`, never a value. No row when nothing moved.
- **2026-10-25** — `payment_receipt` is not sent per payment-request child; `payment_request_paid` sends the one receipt mail (customer resolved from the event). The `payment_request` ad-hoc type accepts `paymentRequestId` (invoice list, live total, earliest due date). `email_config.attachReceiptPdf` (default false) attaches the numbered receipt PDF (`receiptPdfForEvent`; unnumbered → no attachment).
- **2026-10-16** — **`checkout_reminder` (33rd type, E6).** Opt-in: `isEmailTypeEnabled` sends it only on an explicit `types.checkout_reminder: true`, and the settings page's switch starts off to match. Not event-driven and not ad-hoc: `checkout/reminders.ts` renders it and queues an `email_messages` row (`event_id` null) that `deliverPendingEmails` delivers with the usual test-mode, suppression and retry rules. The button is the reminder's own resume link (`checkoutUrl`), not the portal. All five lists updated (EMAIL_TYPES, DEFAULT_TEMPLATES, TEMPLATE_VARS, OpenAPI enum, dashboard `email-types.ts`).
- **2026-10-08** — `subscription_changed` with envelope `settings_only: true` maps to no email: a metadata, PO or collection edit is not news to the customer.
- **2026-10-07** — `enqueueEmails` skips a customer whose `email_notifications` is false: no row, the same as a muted type. Ad-hoc (operator) sends are unaffected. Gate: `verify:emails` Case 11.
- **2026-10-03** — Delivery re-checks the invoice: a queued invoice-scoped mail (`invoice_issued`,
  `invoice_to_pay`, `invoice_overdue`, `payment_request`, `payment_failed`,
  `payment_authentication_required`, `dunning_action_required`, `pre_debit_notification`) whose
  invoice is now `voided` is marked `skipped` with the reason, never sent (`staleForInvoice`;
  counted as `stale`). `invoice_sent` is exempt — an operator forwarding a voided copy meant to.
- **2026-09-30** — Truth audit. `invoice_issued` no longer says the invoice is paid (it is sent
  before the charge). `payment_failed` without an invoice sends nothing (`late_failure` excepted).
  Card/mandate expiry mails only for a card paying for a live auto-collected subscription
  (`charged-card.ts`). A cardless trial's `no_card` cancel (`ended_trial`) sends `trial_expired`.
  Six built-ins lost claims that are false in some cases; `subscription_changed.renewalDate` is
  empty while a cancellation is scheduled.
- **2026-09-29 (latest)** — **Invoice to pay; built-ins with no conditions.** New `invoice_to_pay`:
  `enqueueEmails` swaps `invoice_issued` for it when `isPayableOfflineInvoice` holds, so offline
  invoices get the due date and Pay now while auto-collected ones say nothing is needed. It
  inherits `invoice_issued`'s override (`INHERITS_FROM`, in `loadTemplateOverride`) and on/off
  switch until set on its own. Built-ins reworded after a second review and carry zero
  `{{#if}}`: optional facts live in the facts card (Amount on renewals, method on payment_failed),
  and an empty value alone on its line is dropped (`dropEmptyLines`), so `{{note}}` needs no guard.
- **2026-09-29** — **Variables filled where they were advertised; fewer conditions.**
  `renewal_reminder` and `subscription_renewed` offered `{{amount}}` but never set it (the pass
  now writes the renewal estimate; renewed reads the renewal invoice). Payment emails fall back to
  the payment's amount whenever the event lacks one; `payment_request` due date falls back to the
  issue date; `payment_method_invalid` no longer fakes "ending ••••" for a mandate. Flags corrected
  to `always` where the resolver guarantees a value, and `portalUrl` is always set (falls back to
  `DASHBOARD_BASE_URL`, warns once when neither is configured). Built-ins: 37 conditions → 16.
- **2026-09-29** — **Reset is a draft; operator sends copy contacts.** "Reset to
  default" loads `built_in` into the editor unsaved; `upsertTemplate` treats a save of the
  untouched built-in (CRLF-normalised) as a reset, so no frozen copy is stored. Ad-hoc sends copy
  contacts whenever `to` is the customer's own address — the dashboard pre-fills it, so the
  earlier "only when blank" rule meant dashboard sends never copied anyone.
- **2026-09-29** — **Built-ins reviewed; rail wording.** All 32 built-ins revised after a
  customer-success and an account-manager review. `railLabel` (outbox.ts) turns `mandate_rail`
  codes into "UPI Autopay" / "card" / "bank account" — pre-debit notices printed "upi mandate".
- **2026-09-29** — **Yearly renewal notice: 30 days.** The renewal reminder's lead time
  now depends on the plan (`renewalLeadDays`, subscriptions/reminders.ts): yearly → 30 days, else
  5. `GET /emails/reminders` reports `yearly_days_before`; the hub says "5 days before (30 on
  yearly plans)". `verify:email-reminders` case 1b.
- **2026-09-29** — **Additional contacts get copies.** A customer's contacts flagged
  "send billing emails" / "send account emails" were stored and shown but never mailed. Now each
  email is CC'd to the contacts of its audience (`EMAIL_AUDIENCE`: money mail → billing, lifecycle →
  account), captured at enqueue in `email_messages.cc_addresses` (0301), minus suppressed
  addresses at delivery, merged with the business CC. Ad-hoc sends copy them unless the operator
  typed a recipient. `contact-copies.ts`; `verify:emails` case 7.
- **2026-09-29** — **Footer, per-email attachments, human built-ins.** Built-ins rewritten
  in a person's voice, using `{{#if}}` so nothing renders a hole (unit test: zero warnings). One
  footer resolved template → business → default; `footerNote` is now template syntax, capped at
  1,000. Attachments moved from `attachDocumentPdf` to per-type rules with zero-value options
  (0301). `block_order` is four sections. Business PATCH 400s now carry field reasons.
- **2026-09-29** — **Template editor rebuilt: language, layout, live preview.** New
  `template-lang.ts` (fallbacks, `#if`/`#unless` sections, `checkField`); `renderEmail` uses it and
  honours `ctaLabel` / `showFacts` / `blockOrder` (0301). Save rejects errors; preview returns `issues`;
  test send accepts an unsaved `draft`. Samples gained `deadline`, `nextAttemptDate`, `debitDate`,
  `mandateReference`, `mandateRail` (the pre-debit preview rendered "on " before). Dashboard: rich-text
  body (Tiptap, same tag allowlist) with variable chips, instant debounced preview in a sandboxed frame
  (desktop / mobile / plain text), send-test-to-me. Tests: `test/unit/email-template-lang.test.ts`,
  `verify:email-templates` §8.
- **2026-09-23** — **"Pay now" on an offline invoice's mail.** `invoice_issued` and
  `invoice_sent` get the Pay-now button (pre-authenticated portal link) when the invoice is
  open (`posted`/`payment_due`/`not_paid`), has money due, and is auto-collect OFF — nothing
  else will collect it. Decided at send time by `payable.ts` (`isPayableOfflineInvoice`) and
  carried as the shell-only var `invoicePayable`. Auto-collect-on and paid invoices keep no
  button. `test/unit/email-render.test.ts`, `verify:email-adhoc` §6b.
- **2026-09-21** — **`dunning_retry` deleted; `dunning_action_required` added; a
  "Next attempt" row on `payment_failed`.** `dunning_retry` was selectable, editable, described
  to the merchant as "sent before each scheduled retry of a failed payment" — and
  `emailTypeForEvent` never returned it, so it sent on no event, ever. Removed rather than wired:
  firing it instead of `payment_failed` on retry-armed failures would silently stop a merchant's
  customised failure template being used for most failures (and send NOTHING to a business that
  had switched the type off), while firing it as well is two emails for one event, four rungs
  deep.
  What the customer actually lacked was the DATE, so `payment_failed` now carries it — on the
  FACTS CARD, not in the body. A body sentence renders "We'll try again on ." whenever no retry
  was armed (a park, an exhaustion, a merchant's stop), whereas `add()` drops a row whose value
  is blank. No template body changed, so a merchant who customised `payment_failed` keeps their
  words and gains the row. The value is the instant actually WRITTEN to the invoice
  (`mandateDeferral ?? plan.nextAttempt`) — the two differ on a pending mandate, and naming a
  date the clock will not honour is its own defect.
  `dunning_action_required` serves parked invoices (`invoice_dunning_reminder`). ⚠️ Its button is
  **Update payment method**, not "Pay now", and `email-render` pins it: the invoice IS payable in
  the portal, but paying settles this one and leaves the next renewal to fail identically, while
  updating the instrument settles both via `collect_on_payment_method_update`. The button has to
  agree with a body that says the invoice needs a new payment method. Its `declineMessage` and
  `deadline` are `always` vars carried ON the event, because neither can be read back off the
  invoice at render time.

- **2026-09-11** — **The drain is bounded-concurrent, and the fair share no longer lies.**
  Two changes that only work together. The scan filtered `rn <= TICK_FAIR_SHARE_PER_BUSINESS`, a
  FIXED 50 — while the comment right above it, and the config note, both claimed a business alone
  in the queue is not slowed. It was: 50 rows a minute whether one tenant had mail due or fifty
  did, so a business renewing 1,000 subscriptions produced 1,000 emails and drained 50, growing
  the backlog by 950 every tick with every gauge showing a pass well inside its budget. Now
  `fairShareFor` (`platform/clock.ts`) divides the scan by the number of businesses that actually
  have due work, never below the old floor — so fairness is untouched at the density the cap was
  written for (one business holding 3,095 of 7,654 rows) and the ceiling disappears where it was
  only ever an accident. **Measured at the moment of the change: 385 due for ONE business, old
  share 50/pass ≈ 8 minutes, new share 500 ≈ one pass.** The loop itself is now `runBounded` on
  `TICK_EGRESS_CONCURRENCY`, defaulting to 1, so the deploy is a no-op. Concurrency alone would
  have bought nothing — the pass could not SEE row 51. Safe because the atomic claim already
  assumed concurrent scanners (a travel step and the real tick could always race); the lease, not
  the serial loop, is what stops a message being sent twice. ⚠️ The relay binds before we do — an
  SES account starts near 14/s, and volume a domain has never sent is a deliverability problem no
  concurrency setting solves.
- **2026-09-11** — **`email_messages.duration_ms` (migration `0249`).** The table recorded
  `attempts`, `last_attempt_at` and `sent_at` — enough to say whether a message went and when,
  never how long a send TAKES, which is the one number egress concurrency has to be sized from.
  `gateway_request_logs.duration_ms` has existed all along, which is the only reason the renewal
  path could be sized from real measurements at all. Timed from BEFORE `documentAttachment`, not
  from the transport call: a PDF render is our own work, but the pass waits on it just the same,
  and excluding it would understate the figure. Written on all four outcomes (sent / bounced /
  failed / retrying), last attempt only. Nullable with no backfill — an older row's duration is
  genuinely unknown and a default would read as a measurement, the same rule `transport` follows.
  ⚠️ Distinct from `sent_at - created_at`, which measures how long a message WAITED: that read is
  p50 29s (the designed ~30s wait for a 60s nudge) but p95 **10.3 hours** over the last 21 days,
  and it says nothing at all about send cost. The drain loop is still serial — see PROGRESS,
  and note the fair-share row cap has to be converted before concurrency there buys anything.
- **2026-09-10** — **The ad-hoc sender now brands its mail and mints a real button link.** Four paths
  render a billing email and `adhoc-service.ts` was the only one passing neither the brand vars nor a
  usable `portalUrl`, so an operator-sent `payment_method_request` arrived with `brandedShell`'s
  `#111111` fallback (a black button, the logo as plain text) and an "Update payment method" button
  pointing at the bare `PORTAL_BASE_URL` — the deployment root, no `/portal`, no session.
  `emailPortalLink` + `portalEntryUrl` moved to a new leaf `portal-link.ts` so both senders share one
  definition; a leaf because `outbox.ts` registers an event sink at import time, and the ad-hoc
  sender must not arm the automatic pipeline just by being imported. `email-paths-agree` greps for
  the brand vars and the link mint now, not only for `blocksFor`.
- **2026-09-10** — **One operation, one mail.** `enqueueEmails` mapped 1 event → 1 message, so any
  operation that legitimately emits the same event type twice for the same object mailed the customer
  twice — three `subscription_changed` events from one subscription update became three identical
  mails, and an off-session `requires_action` debit's charge-time notice was followed by the
  gateway's own two seconds later. The guard keys on the OBJECT (`events.resource_id`) and the
  EXECUTION (`events.trace_id`), never the subject: "Here is your invoice" carries no invoice number,
  so two subscriptions billing at once look identical while being perfectly correct. The execution
  scope is load-bearing — a wall-clock window wide enough to catch a duplicate would also swallow the
  dunning ladder's day-8 reminder, because the suites move the billing clock days inside a couple of
  real seconds. `sent` counts alongside `pending` (the clock delivers mid-tick). Events are
  untouched; only the mail is dropped. `verify:emails` asserts both directions.
- **2026-09-09** — **An engine crash in the outbox no longer reads as a flaky relay.** The per-row
  delivery `catch` logged everything at WARNING with no stack, so a `TypeError` thrown inside the
  invoice-PDF renderer was reported as a transient relay failure: Error Reporting skips entries
  without a stack, no alert fired, and three production sends died before anyone knew where. Anything
  that is not a `MailerSendError` is now `log.error(e, …)` — the error object itself, so
  `describeError` extracts the stack Error Reporting groups on — and its first app frame is appended
  to `email_messages.lastError` (`… (at invoice-pdf.ts:629)`), which is what the email-detail dialog
  shows an operator. Relay refusals keep their WARNING and the relay's own words. Separately, the one
  "will retry" line fired for the out-of-attempts branch too, which writes `status: 'failed'`; that
  case now says it gave up. Retry policy, backoff and the `permanent`/`bounced` classification are
  unchanged — an engine fault keeps retrying, so a deploy that fixes the bug flushes the queued mail.
- **2026-09-01** — **A rail-neutral `mandate_expired` template, and a `suppress_email` lever.**
  Filed 2026-09-01 as two of "what the mandate and column work left behind" (`docs/PROGRESS.md`).
  - A lapsed MANDATE (`payment_source_expired` with `expiry_reason: 'mandate'`) routed to
    `payment_method_invalid` as a stand-in — honest routing, borrowed copy. It now routes to the new
    `mandate_expired`: names neither a card nor a date, works for card/upi/emandate alike, and asks
    for the one thing that clears it (a fresh authorization). `card_expired` and `payment_method_invalid`
    are unchanged and still apply to a printed card expiry and an outright refusal respectively.
  - `enqueueEmails` now checks a `suppress_email: true` top-level envelope key before resolving a
    recipient, and returns without enqueueing when it is set — the event (and therefore the webhook)
    still fires. `payment-methods/sweep.ts`'s mandate-expiry backlog cutover now uses it: previously
    the ONLY way to keep the pre-cutover backlog from mailing customers was to not emit the event at
    all, which silenced the webhook along with the mail. It now emits unconditionally and stamps
    `suppress_email` only for the pre-cutover cohort, so a subscriber hears about every real
    transition and the customer is mailed about only the ones worth mailing.
- **2026-08-30** — **`portalUrl` no longer points at a page that does not exist.** `portalEntryUrl`
  built a per-business `/portal/request?business=…` deep link — the self-serve page that asked a buyer
  for their email and mailed them a magic link. That page and its route were deleted the same day
  (an emailed single-use link is spent by the mail scanner before the human clicks; see
  `src/modules/customer-portal/README.md` § "Self-serve access"), which would have left `{{portalUrl}}`
  — a merge variable this file OFFERS merchants on every template type — mailing a 404.
  It now returns `${PORTAL_BASE_URL}/portal`. A buyer whose 72h cookie is still live lands straight in
  their billing portal; one whose is not gets the portal's own "this link is invalid or has expired —
  please ask for a new link" card. Neither is a promise we cannot keep, which the old link had stopped
  being.
  ⚠️ **It could NOT simply return undefined.** `portalUrl` is also the GATE on whether an email renders
  an action button at all: `blocksFor` builds `action` only when it is set, and `resolveRecipient` then
  overwrites that url with the pre-authenticated `/portal/s/<pstk_…>` from `emailPortalLink`. Returning
  undefined would have silently removed "Pay now" and "Update payment method" from every billing email
  while every test that checks the LINK still passed. The business `publicId` threaded into
  `resolveRecipient` for this one call is gone with it — the portal identifies the buyer from their
  session cookie, so a business id in the URL had nothing left to tell.
  `renderPortalMagicLinkEmail` is deleted too: its only caller was the removed flow, and it was outside
  the `EmailType` registry, so nothing else referenced it. `verify:email-events` 64/64.
- **2026-08-29f** — **Credit-note PDFs, and the ad-hoc path that attached nothing at all.**
  0211 attached invoices to automatic mail. Two gaps remained, and the second was the worse one.
  - **Credit notes** now attach on `credit_note_issued` / `credit_note_applied`, via
    `email_messages.credit_note_id` (0213). Two nullable FKs rather than a polymorphic
    `(type, id)` pair — that keeps referential integrity real, and
    `email_messages_one_document_ck` enforces at most one, because a message about two
    documents makes "which PDF?" ambiguous.
  - **The ad-hoc path attached nothing**, so an operator pressing **"Send invoice" sent an
    email that described an invoice and carried none** — the last place a missing attachment
    is acceptable. It never went through the outbox, so it simply never grew the feature.
    Both `invoice_sent` and `credit_note_sent` now attach, through the same helpers.
  - `attachInvoicePdf` → **`attachDocumentPdf`**: a flag whose name says "invoice" while it
    also governs credit notes is the kind of small lie that costs someone an afternoon.
  - `attachments.ts` holds `invoicePdf` / `creditNotePdf`, shared by the outbox and
    adhoc-service so the automatic and operator paths cannot diverge. Both take a PUBLIC id
    only — the uuid/public-id confusion that silently dropped a PDF in 0211 is now
    unexpressible at the signature.
  - Gates: `verify:email-adhoc` 98 → **104**, `verify:email-events` **64** (both halves,
    including that a credit-note email attaches the CREDIT NOTE and not the invoice it
    credits — the plausible-looking wrong-document failure, since the invoice number IS
    rendered in that email's body).
  - ⚠️ `verify:email-bounces` was **not repeatable**: it used fixed provider message ids, and
    `applySesFeedback` correlates on `provider_message_id` alone — right in production, where
    SES ids are globally unique, but on a shared dev database the second run matched the
    FIRST run's row. It also asserted a zero global send-delta, which `deliverPendingEmails`
    breaks by design (it scans system-wide). Both fixed; the suite now passes twice running.
- **2026-08-29e** — **Bounces and complaints, over SNS.** The synchronous half of bounce
  handling has existed since 0166; this is the half that actually matters. `classifySesError`
  said so in as many words — real SES bounces are asynchronous and are NOT in the SendEmail
  response — so until now a hard bounce left the row reading `sent` for ever and the next
  invoice went to the same dead address.
  - **`POST /v1/email_webhooks/ses`** — public and unauthenticated like the gateway webhooks,
    with authenticity from the SNS signature alone. The stakes are unusual: a forged bounce
    would mark a real customer's address undeliverable and suppress every future invoice to
    them, from anyone who knows the URL. So `verifySnsMessage` runs before anything is acted
    on, and rejection is a **403** (an authenticity failure, not a malformed request).
    - The signing-certificate URL is host-checked against `sns.<region>.amazonaws.com`,
      anchored at both ends. This is THE check: the envelope names its own signing
      certificate, so without it an attacker signs a forgery with their own key and we verify
      it happily. `sns.us-east-1.amazonaws.com.evil.test` is the shape it stops.
    - `SignatureVersion` 1 (SHA1) and 2 (SHA256) are both accepted; an unrecognised version
      is REFUSED rather than defaulted, because defaulting to SHA1 is how a downgrade lands.
    - SNS posts `Content-Type: text/plain` even though the body is JSON, so the route needs
      its own raw parser — under the normal JSON parser it receives nothing at all.
    - `SubscriptionConfirmation` is auto-confirmed, but only after the signature verifies and
      only to an allowlisted host: it is the one outbound request we make on an inbound
      message's say-so.
  - **`email_suppressions`** (0212), per BUSINESS and case-insensitive. Two businesses in one
    org have separate customer relationships; a bounce from one says nothing about the other.
    A permanent bounce or a complaint suppresses; a **transient** bounce does not — a full
    mailbox is not a dead address, and suppressing on one would stop mailing a working
    customer for ever.
  - **The outbox honours the list at DELIVERY**, not enqueue, so a bounce landing between
    queue and send still takes effect. That check is the whole point: continuing to mail
    addresses SES has bounced is what drives the account-level bounce rate that gets sending
    paused — one merchant's stale list can suspend the whole account.
  - Visible and reversible by design: `GET/DELETE …/emails/suppressions`. An invisible block
    nobody can lift is its own failure mode.
  - Gates: `verify:email-bounces` (**25 checks**, including that the transport is never asked
    for a suppressed address) and `test/unit/sns-verification.test.ts` (**19**, signed with a
    real generated RSA key rather than a stubbed verifier — a mocked verify would pass whether
    or not our canonical string matches AWS's).
  - Both surfaced in the dashboard (2026-08-29g): **Settings → Email notifications →
    Suppressed addresses** lists them with the provider's own words and a working Remove, and
    the hub card states the count so an operator wondering why one customer went quiet can
    see that something IS suppressed without knowing the page exists. `bounce_type` reaches
    the log's detail drawer, where it draws the actionable distinction — `transient` is a
    full mailbox and the address is fine, `permanent` means the customer record needs fixing.
    Addresses are never ADDED by hand: a suppression means the provider told us something,
    and a typed one would be a claim with nothing behind it.
- **2026-08-29d** — **`ses` was invisible to every reporting surface.** Adding `ses` and
  `unconfigured` to `Mailer['kind']` and `email_messages.transport` did not update the three
  places that ENUMERATE transports, and each failure was the log arguing against mail that had
  actually arrived — the precise thing this column exists to prevent.
  - The hub's activity query listed `('smtp','esp')` as delivered and `NULL or 'console'` as
    not-delivered, so an SES row matched **neither** and disappeared from both counters.
    `not_delivered` is now the **complement** of `delivered`, so the two partition `sent` by
    construction and a fourth transport cannot fall between them.
  - `DELIVERING_TRANSPORTS` (emails/service.ts) states once which transports actually deliver.
    The SQL tuple is built from it, so query and constant cannot drift.
  - The dashboard had TWO copies of the predicate — one in server-only `lib/api/emails.ts` and
    a hand-made duplicate in `emails-table.tsx`, because a client component cannot import from
    a server module. Both missed `ses`. They now share one copy in `lib/email-types.ts`, which
    has no `'use client'` and no runtime server import.
  - Guards, both mutation-tested: `test/unit/email-transport-reporting.test.ts` pins the
    delivering set against `Mailer['kind']` at compile time, and `verify:email-transport` (60 →
    **63**) inserts one row per transport and asserts the buckets partition `sent`.
    ⚠️ The compile-time guard needs `[A] extends [B]`, not `A extends B`: written bare, the
    conditional DISTRIBUTES over the union, a missing member yields `never` for itself and
    `true` for the rest, and `true | never` collapses to `true` — the guard passed while
    proving nothing. Found by deleting `ses` from the list and seeing tsc stay clean.
- **2026-08-29c** — **`ses:GetAccount` dropped, and with it the SES connection test.**
  `GetAccount` reported sandbox status and quota — the one thing this transport could do that
  SMTP cannot — but it is a SEPARATE IAM permission from `ses:SendRawEmail`, and a key scoped
  to sending alone (the least-privilege setup this product asks for) does not carry it.
  - Without that call there is no way to check SES credentials **without actually sending**, so
    a "Test connection" button could only ever report that it could not test. That is a control
    that does nothing, which this codebase forbids, so it is gone: no `SesMailer.verify()`, no
    `testSesConnection`, no `/emails/ses/test-connection` route, no button. The test SEND is the
    honest check and remains.
  - The sandbox warning the test used to give moved into the SES section's help text, where it
    is read before the credentials are entered rather than after.
  - Required permission is now stated as **`ses:SendRawEmail`** everywhere (help text,
    `.env.example`, config comment) — see the entry below for why that differs from
    `ses:SendEmail`.
- **2026-08-29b** — **Raw MIME, and the invoice PDF attachment.** Measured against real
  AWS, which corrected two assumptions at once.
  - **`SesMailer` now sends `Content.Raw`, not `Content.Simple`**, composing MIME with
    nodemailer's own `MailComposer` — the same builder `SmtpMailer` uses, so both transports put
    identical bytes on the wire instead of two dialects of MIME.
  - **This changed the IAM action required, which I had reasoned was impossible.** SESv2
    `SendEmail` is one API call, so the permission looked content-independent; it is not. AWS
    evaluates `Content.Simple` against **`ses:SendEmail`** and `Content.Raw` against
    **`ses:SendRawEmail`**. A key provisioned for nodemailer (which has always sent raw) carries
    the latter, so Simple content was denied on every identity while Raw sent first time. If a
    correctly-configured SES key is refused, this is the first thing to check.
  - **Attachments** (`OutboundEmail.attachments`), honoured by both transports — the reason Raw
    was needed at all, since Simple cannot carry one. `email_messages.invoice_id` (0211) links a
    message to the document it is about; the rendered invoice NUMBER was a string, never a way
    back. Set at enqueue by `resolveInvoice` AND `resolvePayment`, so receipts carry the PDF too.
  - Rendered at **delivery**, not enqueue: a PDF is tens of KB that would otherwise sit in every
    queued row, and the invoice can change in between (a payment lands, a credit note applies).
  - `email_config.attachDocumentPdf`, read **`!== false`** so absent means ON — deliberately
    the opposite of `enabled`, which is read `=== true`. An unset master switch
    must fail closed; an unset attachment preference must not surprise. Exposed on Settings →
    Email notifications → Sender.
  - ⚠️ `assembleInvoiceDocument` takes a **public** id; the column is the internal uuid (a real
    FK). Passing the uuid returned null and sent the mail with no PDF — silently, the exact
    failure the "never drop an attachment quietly" comment warns about. One lookup bridges them.
  - Subjects no longer carry the invoice number (five templates). It remains in the body and on
    the attached PDF, where it is a document reference rather than inbox noise.
- **2026-08-29** — **Amazon SES as a first-class transport, at both levels.** SES was already
  reachable through `smtp_config` via its SMTP endpoint; this adds the SESv2 **API** transport,
  which trades a long-lived SMTP password for an IAM key scoped to `ses:SendEmail` and an opaque
  reply code for a typed error taxonomy.
  - **Deployment-wide** — `MAILER_PROVIDER=ses` + `AWS_EMAIL_REGION` / `AWS_EMAIL_KEY` /
    `AWS_EMAIL_SECRET` (+ optional `AWS_EMAIL_CONFIGURATION_SET`). This is what carries
    **platform** mail belonging to no tenant: operator invites and password resets, which send
    through `resolveMailer(null)`. Named `AWS_EMAIL_*` rather than the SDK's own
    `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` so no other AWS client in the process can
    inherit the mail credential, and so the default provider chain cannot pick it up when
    `MAILER_PROVIDER` is not `ses`.
  - **Per-business** — `businesses.ses_config` (`{enabled, region, accessKeyId,
    configurationSet}`) + `ses_credentials_enc` (`{secretAccessKey}`, the same AES-GCM envelope
    as SMTP and gateway credentials, so `gateway:rotate-credentials` covers it). The access key
    id sits in the NON-secret half for the same reason `username` does: it identifies a
    credential, only the secret authenticates one — and an operator rotating keys needs to see
    which one is installed.
  - **Exactly one transport per business — SMTP or SES, never "the platform default".** A
    business brings its own relay or its own AWS account; the deployment transport exists for
    PLATFORM mail and local dev, and is not a valid business setting, because customer mail sent
    through the platform's relay carries the wrong sending domain, fails the merchant's
    SPF/DKIM, and spends the platform's reputation on someone else's mail. The Delivery screen
    offers two options and preselects neither: a business that has never been configured posts
    an empty choice and is told to make one, rather than having the form choose for it.
    Mutual exclusion is enforced by `businesses_mail_transport_ck`; saving either with
    `enabled: true` switches the other off in the same statement, leaving its credentials intact
    so switching back is not a re-typing exercise.
  - **The engine enforces it too — there is no fall-through.** `resolveMailer(biz)` returns a
    `NoTransportMailer` for a business with no usable transport (none configured, credentials
    that will not decrypt, or half a credential), and that mailer refuses at `send()`. So an
    unconfigured business's customer mail cannot leave on the platform relay, even by accident.
    - It refuses at `send()` rather than at resolve time because `deliverPendingEmails` resolves
      OUTSIDE its per-row try/catch — throwing during resolution would abort the pass and stall
      every other tenant's queue.
    - The refusal is **transient**, so the row stays `pending` and goes out once a transport is
      set up. Marking it `permanent` would file it as `bounced`, blaming a blameless customer
      mailbox for the merchant's missing configuration.
    - The row records `transport: 'unconfigured'` (migration `0210`) — a distinct fact from
      `console` (a sink accepted it and delivered nothing) and from NULL (predates the column).
    - `resolveMailer(null)` is untouched: platform mail belongs to no tenant and still rides the
      deployment transport.
    - Consequence for local dev and for suites: a business with no transport no longer reaches
      the console sink. Every email suite already installs a fake via `setMailer` (which still
      outranks everything); `verify:worker` needed one added, because its scan-cap section was
      the one place that had been relying on the fall-through to deliver.
  - **`classifySesError` never blames a mailbox for our configuration.** `permanent` is not
    "stop retrying" — `deliverPendingEmails` turns it into `bounced`, which means *the far side
    refused this address*. SESv2 gives no per-recipient structure (no analogue of nodemailer's
    `rejected`) and real SES bounces arrive asynchronously over SNS, so a synchronous throw is
    nearly always account- or identity-level: suspended, paused, sandboxed, unverified From.
    All stay transient. The single exception is a `MessageRejected` naming the account
    suppression list, matched on wording because nothing structural distinguishes it — a
    trade-off recorded in the code, and one that degrades toward retrying, never toward a false
    bounce.
  - **`describeTransport`** (`transport-view.ts`) is now the one place the resolver's precedence
    is mirrored for display, shared by the SMTP and SES settings views so they cannot give a
    business two different answers to "what is carrying my mail".
  - **`verify()` beats the SMTP equivalent**: `GetAccount` reports sandbox status and quota, so
    "Test connection" can say *your credentials work but only verified recipients will receive
    mail* before the first real customer send — the most confusing SES failure there is.
  - Gate: `pnpm verify:ses-transport` (48 checks) drives a local server that speaks the SESv2
    wire protocol, so the adapter is proven to really form a signed SendEmail call rather than
    to satisfy a mock.
- **2026-08-26** — **A sender problem was being filed as a recipient bounce.** Any 5xx was
  `permanent`, so an unverified From domain (`550 … not authorized to send emails from
  <domain>`, measured against a real relay: `EMESSAGE` / `DATA` / no rejected recipient)
  marked every recipient `bounced` — the status whose whole meaning is "fix the customer's
  address" — and did it terminally on the first attempt, discarding the queue while the
  merchant's From address was misconfigured. `classifySmtpError` now keys off nodemailer's
  `rejected` list: a 5xx that refused no recipient is a message/sender refusal and is
  retriable, matching the `EAUTH` precedent. Pinned in `test/unit/smtp-classify.test.ts`
  from both directions, with the real error shape rather than a guessed one.
- **2026-08-26** — **Rich-text bodies, the three shell blocks, four new types, and a CTA that
  goes somewhere.** We had escaped plain text and one hardcoded "Manage billing" button.
  - **`sanitize.ts`** — bodies may now carry `a b strong i em u h1 h2 ul ol li p br`. A
    rebuild-from-scratch tokeniser: nothing from the input reaches the output, so anything it
    cannot parse degrades to escaped text rather than surviving as markup. `href` is limited to
    `http(s)`/`mailto` after entity **and** control-character decoding (`&#106;avascript:` and
    `java\nscript:` both die). `renderEmail` sanitises the TEMPLATE then substitutes escaped
    values — **that order is the security argument**, see the comment there.
    - It must be **idempotent**, because it runs at save AND at render: with a plain
      `escapeHtml` the second pass turned a stored `5 &lt; 6` into `5 &amp;lt; 6` and shipped
      the markup to the customer. Text nodes now preserve already-valid entities.
    - A `<script>` is dropped **with its content**. It used to be escaped into VIEW — and
      `verify:email-templates` asserted the escaped text stay visible, so we printed
      `<script>alert(1)</script>` into customers' billing email.
  - **Card / action button / footer note** — the three shell blocks, as
    `RenderVars.facts` / `.action` / `.footerNote`. All three are rendered by `brandedShell` from
    resolver data, never merchant markup, so they need no sanitising and a template edit cannot
    forge them. `blocksFor` (in `templates.ts`, so both the outbox and the preview reach it) is
    the one table mapping "which facts does this email state" to "which vars hold them". A row
    whose var is absent is DROPPED rather than rendered blank.
  - **`portalUrl` was a defect.** It was `config.PORTAL_BASE_URL` — the bare deployment-wide URL,
    so every billing email's button led to a page that could not know who arrived. Now a
    per-business `/portal/request` deep link. It deliberately carries **no portal session**:
    `createPortalSession` mints a 72h bearer credential, so one in every dunning email makes a
    forwarded mailbox into account access, and the day-8 notice would carry an expired token.
  - **Four new types** — `trial_started`, `trial_expired`, `trial_extended`,
    `payment_method_invalid`, plus a `paymentMethodType` var. No migration: `email_templates.type` has no CHECK on its value. Triggers, all
    proven through real service calls in `verify:email-events`:
    | type | fires on |
    |---|---|
    | `trial_started` | `subscription_started` with `status: 'in_trial'` — the same event with `active` correctly sends nothing |
    | `trial_expired` | `subscription_canceled` with `cancel_reason: 'trial_ended'`. **This used to send the ordinary cancellation email**, so a customer who simply never subscribed was told their subscription had been cancelled |
    | `trial_extended` | `editTrialEnd` moving the boundary LATER. The flag rides on the event ENVELOPE, not the resource — `buildEventContent` replaces the resource with the snapshot, which is how the dunning-cancellation branch broke once already |
    | `payment_method_invalid` | new `payment_source_invalidated` event. `setPaymentMethodStatus(…, 'invalid')` changed the row and told nobody: no webhook, no email, for the one payment-method state the customer must act on. Re-invalidating a row already `invalid` no-ops, so a dunning run does not mail per attempt |
  - **The preview now renders the whole email.** It was passing sample vars straight to
    `renderEmail`, so the editor showed no card, no typed button and no sign-off while telling the
    merchant it was exactly what sends. It calls the outbox's own `blocksFor` now.
  - **Imported copy lands as per-business overrides, never in `DEFAULT_TEMPLATES`** — a shared
    default is shipped to everyone who buys tmbilling, so one merchant's marketing in there is a
    leak. An importer also has to **rewrite stale origins**: 13 of one merchant's 20 live templates still
    linked to the old app host, and the rewrite target carries `/pricing` because that is the only
    page where a card can be added — a dunning notice that lands the payer on a dashboard they then
    have to navigate is a notice that does not get paid. One button with an explicit target
    ("Upgrade Plan" on trial expiry) survives as a **link in the body**, since the shell's action is
    billing-portal shaped and the engine has no notion of the merchant's own app URL; dropping it
    would have removed the entire call to action from a trial-conversion email.
  - **Real delivery needs four env values, not one.** Verified against the live Resend relay on
    2026-08-26: `SMTP_HOST/PORT/USERNAME/PASSWORD` were all set and **nothing would have sent**,
    because `MAILER_PROVIDER` defaults to `console` — configured-and-ignored is indistinguishable
    from working. Also `SMTP_ENCRYPTION` defaults to `starttls` while port 465 is *implicit* TLS
    (`resolveSmtpConfig` infers `465 → tls` for a per-business config; the deployment-wide path
    does **not** infer), and `MAIL_FROM` must be a domain the relay has verified — an unverified
    one is refused at RCPT with `550 … not authorized to send emails from <domain>`.
- **2026-08-22** — **`{{customerName}}` unified on ONE chain, and it is deliberately not the invoice's.**
  The outbox (`outbox.ts`) and the ad-hoc sender (`adhoc-service.ts`) each carried their own copy of
  the fallback ladder, and the ad-hoc copy's doc comment claimed it matched the outbox — which it did,
  by coincidence, until either was touched. Both now call `accountHolderName` from
  `customers/names.ts`. That is the ACCOUNT HOLDER (structured first/last → company → email; the
  legacy `name` column was the second-to-last arm until it was deprecated on 2026-08-23), NOT the
  `invoiceContactName` the invoice PDF prints: a buyer whose invoices
  are addressed to their company's accounts-payable contact must still be greeted by their own name,
  so "Hi Accounts Payable," can never happen. The visible change is precedence — first/last now beat
  the invented `name` column, which used to win. Gated by `verify:emails`.
- **2026-08-17d** — **`payment_authentication_required` added, and one existing type was
  found unmanageable.** The new notice fires when an INR mandate debit above ₹15,000 is paused for
  the payer's bank approval — deliberately NOT `payment_failed`, because nothing failed and telling
  someone to "update your payment details" when their card is fine is how a recoverable renewal
  becomes churn. It does not embed `{{portalUrl}}`: the shared footer already appends it, and with
  no portal configured the sentence ended "pay directly here: " with nothing after it.

  ⚠️ **`EMAIL_TYPES` is `readonly EmailType[]`, so a MISSING entry is not a type error** — only a
  wrong one is. `pre_debit_notification` had been absent since it shipped, and that array drives the
  settings toggles, the template editor and `resolveEmailConfig`'s per-type parse. So the NPCI
  compliance notice was sending, while being invisible in the UI, uneditable, un-toggleable, **and
  having any stored preference for it silently dropped on every read**. Now listed, plus a unit test
  pinning `EMAIL_TYPES` against `DEFAULT_TEMPLATES` (the compiler-exhaustive `Record`). The same test
  pins the hand-copied enum in `src/api/openapi.ts`, which had drifted to **5 of 25** and documented
  `/emails/templates/{type}` as rejecting twenty types it accepts.

  Both new entries land in groups the hub already renders, so `pre_debit_notification` also joins
  `REMINDER_LEAD_DAYS` (17b) — it is the one reminder with a legal deadline, and leaving it as the
  only row whose timing the screen could not state would reintroduce exactly the vagueness that map
  was added to end.
- **2026-08-17c** — **A permanent refusal is no longer retried six times.** New `bounced` status
  (plain-text column, no CHECK, so no migration): an SMTP **5xx** goes terminal on attempt 1 instead
  of burning six retries over six hours and then landing as `failed` with the reason buried.
  Classification lives at the adapter boundary (`MailerSendError { permanent, code }`, thrown by
  `classifySmtpError`) because the engine may not know what a reply code is; a plain `Error` stays
  transient, so the console sink and the esp stub are unaffected. `EAUTH` is transient on purpose.
  `failed` and `bounced` are separate figures on `…/emails/activity` and separate segments in the
  log. Both directions proved against sinks that refuse at RCPT TO with `550` and `451`
  (transport suite 42 → 57). **Scope: synchronous refusals only** — asynchronous DSN bounces still
  need an ESP webhook or an inbound DSN parser, and the log leaves those rows `sent` rather than
  guessing.
- **2026-08-17b** — **CC / BCC / subject prefix, and the reminder lead times are no longer a
  secret.** Three new `email_config` fields (no migration — it is jsonb) reaching every send path
  through a new single `resolveSender()` / `applySubjectPrefix()`, which replaces the
  `fromX || MAIL_FROM_X` rule that had been open-coded in four places and was wrong in one of them.
  BCC-must-not-leak and empty-list-emits-no-header are asserted against the real in-process SMTP
  sink (transport suite 29 → 42 checks); prefix-at-enqueue and no-double-prefix through the real
  enqueue→deliver path (emails suite 9 → 14). New `GET …/emails/reminders` publishes the 3/5/5 lead
  times with `configurable: false`, so the hub prints "Fires 3 days before" instead of "a few days"
  without offering an input that would post nowhere.
- **2026-08-17** — **Settings → Email notifications split into a hub + two sub-pages.** The one page
  had grown to four independent forms and two competing Save buttons in a 672px column on a 1204px
  canvas — 3892px of scroll. Sender identity and SMTP transport now have their own pages
  (`settings/emails/sender`, `settings/emails/delivery`), reached from a strip that reports each
  one's **resolved** value; the hub keeps the master switch and the 20 per-type switches in the
  `settings-hub` two-column archetype with per-group "N of M on" counts (2821px, one Save).
  Two false defaults found and fixed while tracing the controls (see "The From identity is resolved
  by the engine" above) — both were confidently-worded sentences that no gate could catch. New
  `GET …/emails/activity` backs the hub's activity figure; it reports `delivered` and
  `not_delivered` separately, because a single "3 sent" would have been three console writes.
  **`email_config` is one jsonb column and is now written from two pages**, so each action re-reads
  and merges rather than PATCHing its own half — otherwise editing the From name would have silently
  switched sending off. Both directions verified end-to-end through the real server actions.
- **2026-08-10** — **5 email types → 24.** Seventeen event-driven (most of them mapping events the
  engine *already emitted* and nobody consumed), three reminders, four operator-initiated. Found and
  fixed a latent bug on the way: the enriched cancellation payload spells the field `cancel_reason`,
  the map read `reason`, so **every real dunning cancellation email silently never sent**. Dates now
  render business-local through the invoice formatter, so an email and the document it names can
  never disagree about the day. Still open: no drafts/test→live, no sender profiles, no i18n, and
  ~29 notification types are unbuilt (multi-profile dunning, portal account mail, cart abandonment).
- **2026-08-09** — **Real delivery, and an honest record of it.** Implemented `SmtpMailer`
  (nodemailer) behind the existing adapter boundary; added per-business SMTP settings
  (`smtp_config` + encrypted `smtp_credentials_enc`, migration 0166) resolved per business rather
  than one process-wide singleton; added `email_messages.transport` so `sent` stops being an
  unfalsifiable delivery claim. Added `email_config.fromAddress` — and found it was being **dropped
  by the business PATCH zod schema**, so mail went out as the deployment default while the settings
  screen showed what the merchant typed. Added per-business template overrides (`email_templates`,
  migration 0167) with a two-pane editor, engine-rendered preview of unsaved drafts, and
  reset-to-built-in. **`renderEmail` now escapes the template text, not only the substituted
  values** — merchant-editable bodies made the old behaviour a stored-XSS path into that merchant's
  customers' inboxes; `verify:email-templates` caught it. Still open: no template drafts or
  test→live promotion, and the trigger set is still 5 triggers wide.
- **2026-07-21** — Module created (Tier-1 M13): event-driven customer billing emails via a provider-agnostic
  mailer adapter (console dev sink; SMTP/ESP pluggable), built-in templates, opt-in per business,
  dashboard log + resend. Mirrors the webhook outbox pattern.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-10-05** — `payment_source_invalidated` with top-level `invalid_reason: "mandate"` routes to `mandate_expired` (renew the authorization) instead of `payment_method_invalid`. Emitted by a gateway dead-mandate decline and by a rejected/cancelled mandate webhook.
- **2026-10-11** — `payment_request` quotes `invoiceOutstanding` (payments subtracted), not the stored `amount_due_minor`, which is net of credits only: a part-paid invoice asked the customer for its whole balance again. Gate: `verify:reactivation-in-term` part-paid case (fails on the old line).
- **2026-10-16** — The facts card's Payment method row names the charged card (`Visa ···4242`) on `payment_failed`, `payment_authentication_required` and `payment_receipt`, resolved from the payment or, for a charge still awaiting approval, the invoice's latest attempt (`attemptedMethod`). Without a card number it prints the rail words sentence-cased ("Card", "UPI Autopay"), never the raw lowercase type. `brandWords` maps stored networks (`american_express` → American Express; `other` → none), so the card-expiry bodies read "The Visa card" too. Proof: `test/unit/email-render.test.ts`.
- **2026-10-16** — Test mode sends only to team members (`test-mode.ts`). The outbox skips a
  non-member To address with the reason on the row and drops non-member contact copies; an ad-hoc
  send to a non-member is refused with a 400. The business's own configured copies still go out.
- **2026-10-19** — `MAILER_CONSOLE_DELAY_MS` (default 0): the `console` sink waits this long per
  message, standing in for a relay's response time in load runs (`scripts/loadtest/run.ts`).
- **2026-10-21** — The email outbox claims its pick in one `update … skip locked` and hands unreached rows back at once.
- **2026-10-22** — `body_removed_at` (0357): the retention sweep (`modules/ops/retention.ts`)
  empties a sent email's bodies after its period (default 90 days) and stamps it; the record
  stays. Resend refuses such an email with a 409, and the dashboard shows a note instead of the
  preview.
- **2026-10-24** — `GET …/emails/reminders` reports this business's lead days (0376): each row
  adds `lead_days`, `configurable` (false for `pre_debit_notification`) and, for renewals,
  `yearly_lead_days`; `days_before` is the largest. Settings → Email notifications links each
  configurable reminder to Settings → Subscription reminders.
- **2026-10-25** — Account security notice `role_changed`: a member is told when an owner or
  admin changes their role.
- **2026-10-28** — `pre_debit_notification` takes `achDebit` (an ACH debit under our
  authorization): the default body then tells the payer to cancel with the business or remove
  the bank account in the portal, 3 business days ahead. `railLabel("ach")` = "US bank account
  (ACH)".
- **2026-10-28** — New type `ach_authorization_copy` (Reg E 12 CFR 1005.10(b): the payer gets a
  copy of the ACH debit authorization we took). `persistVaultedPaymentMethod` emits
  `payment_source_updated` with top-level `ach_authorization: pma_…` in the transaction that
  stores the `payment_method_authorizations` row; the outbox maps it, reads the row and sends
  the STORED text, version and accepted time to the payer email on the row. Per-business switch
  like every automatic type. A line break inside a body value now renders as `<br>`. The
  preview sample no longer sets `achDebit`, so the pre-debit preview shows the mandate wording.
- **2026-11-03 (0492)** — Retired keys `attachInvoicePdf` / `attachDocumentPdf`
  (`LEGACY_EMAIL_CONFIG_KEYS`) are dropped from the business read and from a PATCH, and 0492 removes
  them from stored rows. A stored `attachInvoicePdf` made every email settings save 400. `attachments`
  stays the attach setting. Gate: `verify:settings-invoices-org` H.
- **2026-11-03 (security)** — The portal sign-in code also clears `bcc`: the business BCC list
  (`email_config.bcc`) no longer gets a copy of a live code.
