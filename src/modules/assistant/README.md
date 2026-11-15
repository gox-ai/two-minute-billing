# assistant — Billy, the in-app assistant's backend

> Source: `src/modules/assistant/` · Routes: `src/api/assistant-routes.ts` · Schema: `db/schema/assistant.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
**Billy** (the name lives only in `name.ts`) answers a dashboard member's questions about their
billing data and the product. It reads by default; when an owner turns actions on, it can
also prepare changes the member confirms (`actions.ts`).
The model calls the tool catalogue (`assistant-tools`); every tool call is an in-process
request with the member's session, so their role, RLS and the test/live partition apply as if
they had clicked.

## Responsibilities
- `llm.ts`: which model, on whose key — the organization's own key, else the platform
  `ASSISTANT_*` key, else off. The only place a provider SDK is imported. OpenAI through the
  Responses API (`store: false`); `ASSISTANT_BASE_URL` for an OpenAI-compatible local server.
- `run.ts`: one turn — cap and switch checks, history (~24k chars), tools the member's role
  allows, `streamText` with ≤ 8 steps, events, the figure check, the stored message, usage.
- `research.ts`: the reference pack before the first call (`prefetch`, up to 5 s) and the `research`
  tool after it; each source runs its catalogue tool. `read-api.ts`: `read_api` as the app's model
  gets it (path mending, the readable paths near a wrong one). `follow-ups.ts`: the chips line.
- `figures.ts` (pure): every number in the answer must appear in the turn's tool results
  (as stored, ÷100, ×100, inside strings); others are `unverified` and the panel marks them.
- `service.ts`: settings (own key encrypted with `platform/secrets`, only last 4 returned),
  conversations (the member's own), messages, the usage ledger and the monthly cap.
- `allowance.ts`: the allowance arithmetic. The allowance itself is
  `organizations.assistant_allowance_usd_cents`, written by account billing from the plan.
- `allowance-notice.ts`: the 80% email to owners and admins, once a month.
- `name.ts`: `ASSISTANT_NAME` ("Billy") for every message a member reads.
- `actions.ts`: the allowlist of changes Billy may prepare (`ACTION_OPS`, three tiers), the
  proposal built from the stored request and the engine's preview (never from model text), and
  confirm / cancel. A confirmed change runs once through the same /v1 route as the dashboard,
  with the member's session, one idempotency key and `x-tmb-via: assistant`.
- `support.ts`, `support-context.ts` (Cloud only, 0512): support requests. `propose_support_request`
  drafts a card (subject, description, attached items: page, records the member's own reads
  returned or their page/mentions read again as them, failed requests, the conversation, the
  browser), stored in `extras.support_draft`. The member edits it, removes items, attaches a
  screenshot and sends it; the server builds the request from the stored draft, less what was
  removed, through the secret guard (`redactSecrets` in `leaks.ts`). Staff (back-office) reply,
  resolve and reopen through the `…ForStaff` functions; a staff reply is signed
  "Two Minute Billing support", sets `member_unread_at` and emails the member. Support replies
  are never put in the model's history.
- `support-notify.ts` (Cloud only, 0513): staff notices. Each member message queues two
  `support_notice_send` jobs (chat, email) in the transaction that stores it, through
  `public.app_queue_support_notice` (SECURITY DEFINER: the tenant role cannot call `add_job`). The
  engine worker sends them within seconds: a chat line to `SUPPORT_CHAT_WEBHOOK_URL` (unset =
  `OPS_ALERT_WEBHOOK_URL`) with organization, subject and link only, and the whole request to
  `SUPPORT_EMAIL` with no Reply-To. Link = `BACKOFFICE_PUBLIC_URL/support/<id>`, left out when
  unset. Job key `support_notice:<channel>:<message>`: one job per channel, so a failed channel
  is retried alone (10 attempts) and the other is never sent twice. `notified_at` = first delivery.
- `action-lines.ts`: what the confirm card says. Each field in the label and option words of the
  dashboard form that makes the same change (`FIELDS`, per-operation `OP_FIELDS`), dates in the
  business's zone, amounts in the record's currency, record ids as names (`lookupNames`, one read
  per record), lists and settings as rows, never JSON. Display only: the request is not changed.

## Data model
`assistant_settings` (on by default; 0507 `allowance_warned_month`; 0508 `actions_enabled`, `money_actions_enabled`, both off), `organizations.assistant_allowance_usd_cents` (0507, read only), `assistant_conversations`, `assistant_messages`,
`assistant_usage` (append-only; `billed_to` platform | organization; `cost_fixed12` from the
model price book, null when unpriced). 0508: `assistant_messages.extras` (suggestions, question,
proposal, attachments) + `feedback`/`feedback_comment`/`feedback_at`; `assistant_attachments`
(screenshots, `bytea`, ≤ 10 MB, deleted with the conversation and after 90 days by
`retention_sweep`); `assistant_actions` (one row per proposal: the request as sent, tier,
status, idempotency key, the card shown, the result). 0512: `support_requests` (SR-<number>
from `support_request_number_seq`, status open | waiting | resolved, the kept context, the
member's Idempotency-Key, last member/staff reply, `member_unread_at`) and `support_messages`
(member | staff | system, screenshots by attachment id, `staff_by` for the back-office only,
`notified_at` set when staff are first told). 0519: `assistant_conversations.archived_at`,
`pinned_at`, `shared_at`. All behind RLS.

## API routes (signed-in member)
| Method · Path | Purpose |
|---|---|
| `GET /auth/assistant/status` | Available / switched off / allowance used |
| `GET /auth/assistant/conversations?business=&q=&archived=&limit=&starting_after=` | The member's conversations: pinned first (newest pin), then by last message; `{ data, has_more, next_cursor }`. `q`: every word in the title or in one message (ILIKE), with a `snippet` |
| `GET …/conversations/:id` · `PATCH …/:id` · `DELETE …/:id` | Read, change (`title`, `archived`, `pinned`, `shared`; owner only) or delete one |
| `GET /auth/assistant/shared/:id[?business=]` | A shared conversation, read-only, for any member of the organization; 404 when not shared |
| `POST /auth/assistant/messages` | Ask (`tool` = a menu task, `mentions`, `attachments`): SSE stream of `conversation`, `tool_status`, `tool_data`, `text_delta`, `figures`, `suggestions`, `question`, `proposal`, `allowance` (≥ 80%, enforce), `usage`, `done` or `error` (with `actions` when used up) |
| `PUT /auth/assistant/messages/:id/feedback` | Helpful / not helpful (+ optional comment) on the member's own answer |
| `GET /auth/assistant/mentions?business=&q=` | @ search over customers, invoices, subscriptions, as the member |
| `POST /auth/assistant/attachments` · `DELETE …/:id` | A screenshot (PNG, JPEG, WebP by its bytes; ≤ 10 MB; base64 JSON) |
| `POST /auth/assistant/actions/:id/confirm` · `…/cancel` | Run (as the member) or withdraw a prepared change; tier 3 needs `confirm_money: true` |
| `GET/PUT /auth/assistant/settings` | On/off, own key (tested before saving), actions switches, this month's usage |
| `POST /auth/assistant/support/requests` | Cloud: send a drafted request (`Idempotency-Key` header; `conversation`, `draft`, `subject`, `description`, `remove`, `attachments`). 201, or 200 for a repeat of the key; 409 once the draft was sent |
| `GET /auth/assistant/support/requests` · `GET …/:id` | Cloud: the member's own requests (+ `unread`), one thread |
| `POST /auth/assistant/support/requests/:id/messages` · `…/read` | Cloud: the member replies (a reply opens a resolved request again); clear the unread dot |

Self-hosted, every support route is 404, `status.support` is null and the model is never offered
`propose_support_request`.

## Invariants & gotchas
- **Billy acts as the member, never more.** Tools and proposable operations are filtered by
  the member's permissions; every call (read or confirmed write) carries their session, so the
  route checks again. Only the member who asked can confirm; the audit trail records them with
  `source = 'assistant'` ("via Billy"). Only an in-process call (the per-process inner-call
  header) can claim that source; an outside `x-tmb-via` header is ignored.
- **Actions** are off until an owner turns them on; money actions (tier 3: refunds, credit
  notes, collections, invoicing now, applying credits, recording a payment, void/write-off,
  cancelling now with credit) need a second switch and `confirm_money` on every confirm.
  Proposals expire after 15 minutes and run at most once. Deletes, payment methods, settings,
  team and keys are never on the allowlist, and MCP never offers actions.
- **Questions with options** (`ask_member`) and **proposals** end the turn (`hasToolCall`); the
  next turn's history carries what was asked or prepared. Follow-ups (`suggest_follow_ups`)
  are chips, not steps.
- **Screenshots only** (user decision, safety): PNG, JPEG, WebP judged by their bytes; never
  PDF, CSV or SVG. Treated as data, never instructions.
- **Cloud: the allowance per plan** (Free $0.10, $29 $0.60, $99 $2, $299 $6, agreement $6 of our
  model cost a month, the same dollars in every currency) is written to the organization row
  by account billing (every minute for a plan change, every 15 minutes for all) and replaces
  the token cap. The engine never calls the back-office. Cost is `cost_fixed12` from the model price book; an unpriced turn
  counts at $1 per million tokens. `ASSISTANT_ALLOWANCE_MODE=record` (default) measures and
  shows it; `enforce` stops platform-billed turns at 100% (`cap_reached`, with Upgrade plan /
  Add your own key) and adds a note plus one email a month at 80%. Own-key turns never count.
- Without an allowance (self-hosted, or a new organization not yet swept), the token cap
  (`ASSISTANT_ORG_MONTHLY_TOKENS`; default 2M on Cloud, none self-hosted) is checked before a
  platform-billed turn; a turn in flight finishes. Own-key turns are not capped.
- An own key that fails is an error to the owner; it never falls back to the platform key.
- Tools a role cannot read are not offered; `read_api` stays bounded by the route's own check.
- Scope is enforced, not hoped for: off-topic, harmful and prompt-extraction requests go through
  the `decline_request` tool, so each decline is a recorded step (`assistant_declined` log);
  5 declines by one member in 24 h log `assistant_abuse_suspected` (error level, alertable).
- Per member: 30 questions per 10 minutes and 200 per 24 hours, read from `assistant_usage`
  (the shared rate-limit counters are swept after 2 h, too short for a day). 429 + Retry-After.
- Docs links and dashboard paths in an answer must be ones a tool returned
  (`unverified_links`); others render as plain text, like unverified figures.
- Source is a reference, never an answer (`leaks.ts`): `search_source` is assistant-only (not
  MCP), its results stay out of the evidence, "View data" and the stored message, and a turn
  that read source holds its text until the guard removed copied lines, fenced code, repository
  paths and camelCase identifiers found in that source. API examples from the docs stay.

## Changelog
- **2026-11-15 (fix/show-me-targets)** — A Show me step names only a control: `resolveGuide`
  refuses the page title, a breadcrumb and a heading (a heading may still be `within`, and gets
  its own error), and takes an option a screen lists from a catalogue (each provider on Add a
  gateway). The runner never rings a breadcrumb, the page title or the assistant; it rings only a
  control the member uses (an option card hugs as its button) and shows any other step
  unanchored with its instruction; the coach card keeps clear of the target's section title.
- **2026-11-12 (fix/billy-upcoming-by-type)** — The prompt sends every sum, count, average or
  breakdown question to `query_records` (assistant-tools); the panel draws its result as a stat
  row of the totals and a table of the groups (`queryRecords` in `tool-data.tsx`). A figure the member wrote in their question
  ("I need $170") counts as evidence for the figure check, so repeating it back is not flagged.
  The panel's upcoming-charges card shows the amount per payment type.
- **2026-11-12 (fix/billy-quality)** — From the first production conversations after the fast
  turns. The prefetch waits up to 5 s (was 1.5 s, which dropped a source in 5 of 8 turns and cost a
  research call and a model step each); `assistant_turn_timing` adds `prefetch_sources_ms` and
  `prefetch_missing`. Prompt: the question sets its own scope (the page and earlier turns fill only
  what it leaves open; a correction wins), ask when two readings answer differently, run a read
  instead of offering it, never "he"/"she" from a name. A bare help URL becomes a link titled by
  its page (`linkBareUrls`). Overfitting removed: the propose check no longer parses the member's
  words (`askedToCreate` gone; required fields and the Show me path cover it); Show me steps carry
  `do` (click | enter | select | submit), so the page stops guessing from verbs; the turn's search
  audience comes from the page (a developer screen → developer), and the model widens it.
  Memory across turns: `earlierRecords` collects the records earlier answers read (from their
  stored tool results, newest first, ≤ 40) and the turn's reference lists them by id and name
  (≤ 1,500 characters); their ids count for Show me params and record links, never as figure
  evidence. The prompt carries the member's name and today's date in the business timezone
  (`todayIn`). The model stream stops after 90 s (`assistant_turn_timeout`, an error the member
  sees); the SSE route sends `: ping` every 15 s. Output limit 4,000 tokens; an answer cut at it
  ends with a note (`assistant_answer_cut`). `figures.timing` stores the turn's timing for the
  back-office. Menu tasks are `explain_invoice` and `explain_mrr_change` only. @ mentions add
  credit notes and payments, and a subscription reads as its plan and payer. Cloud: a thumbs-down
  posts one chat line (organization, question, comment; never the answer or ids).
  Editable cards: a card's lines carry `key` and `input` for plain scalar fields (text, number,
  amount in major units, bps as a percent, date, instant, select, boolean; never record ids,
  nested values or hidden fields). `POST /auth/assistant/actions/:id/edit` takes `{fields}` (and
  `note` for an email): `editAction` coerces the values, re-runs the propose checks (`buildCard`:
  required fields, changed fields against a fresh read, the engine preview, the email render),
  recomputes the tier (a change that now moves money is refused when money changes are off),
  and stores the new card; a refused edit changes nothing. The panel shows "Edit" on a waiting
  card, saves only changed fields, and Confirm waits while editing. Gate: `verify:billy` § K.
  Panel cards for the new tools (`dashboard/components/assistant/tool-data.tsx`): payer and
  open-dispute lines, catalogue, upcoming charges, timeline, collections queue, payment and
  balance explanations. Starters follow the record's state (`startersFor`, `recordState`).
- **2026-11-11 (perf/billy-fast)** — Fast turns. Before the first model call, `research.ts`
  searches the help (its API pages for API questions), the screens and the code with the
  member's question and reads the page's record, in parallel within 1.5 s (a slow source is left
  out); the pack follows the question in the first call as plain text with links ready to copy.
  Follow-ups use one `research` tool (all sources in one step); `search_docs`, `find_screen` and
  `search_source` are no longer offered in the app (MCP unchanged). `get_api_reference` stays,
  described as the last resort for exact field rules; a refused proposal now carries the
  operation's body in one line (`compactSchema`, `withSchema`), and a per-item coupon that names
  no item is refused (`SHAPE_RULES`). The pack's help figures count as evidence only for a page
  the answer cites. Tool results reach the model lean (`shapeForModel`, 20,000 characters, lists
  at 10 rows); cards and stored rows are unchanged. Follow-up chips come from the answer's last
  line, `Follow-ups: a | b | c` (`follow-ups.ts`, held out of the stream), not from a tool: the
  tool cost one more round trip on most turns. The platform OpenAI model reasons at low effort
  (`ASSISTANT_REASONING_EFFORT`, default low; own keys keep their default). The source guard
  streams word by word (`StreamGuard`) instead of holding the answer, and still checks the whole
  answer at the end. `read_api` (`read-api.ts`) mends a full `/v1/businesses/…` path, a `?query`
  in the path and nested filters, and answers an unknown path with the readable paths near it.
  One `assistant_turn_timing` log line per turn (total, first text, prefetch, model vs tool ms
  and tool names per step, calls, tokens; no member content). Prefetched steps are stored with
  `prefetched: true` and never shown (`memberSteps`). A link no tool returned is taken out of the
  answer, its words kept (`dropUnverifiedLinks`, `figures.removed_links`); the pages of records
  the turn read count as given (`recordPaths`). Gates: `verify:assistant` (§ B12, § R),
  `verify:billy`, unit `assistant-fast-turn`; `verify:assistant-live` before/after in PROGRESS.
- **2026-11-11 (fix/premium-polish-5)** — Chat history (0519): search (title or one message holds
  every word; plain-text `snippet`), rename, archive, pin and read-only sharing inside the
  organization, with a keyset cursor over pinned-then-activity order. A rename, pin, archive or
  share never moves `updated_at`; archiving unpins; pinning or a new message brings an archived
  chat back. The shared read leaves out the owner's screenshots, support draft, chips, prepared
  changes and rating, and record cards from tools the reader's role cannot use. Gate:
  `verify:assistant-history` (mock model, no provider calls).
- **2026-11-10 (fix/show-me-gaps)** — Several exact matches: the step's `say` picks a field
  (enter a value, a number) or an option (select, switch to), then the named row, then the first
  (`stepIntent`, `chooseExact` in `dashboard/lib/guide-match.ts`). `show_in_app` asks for the
  field's label and the value in `say`. Gate: unit `guide-match`, `verify:billy` S2 68/68.
- **2026-11-10 (fix/show-me-target)** — A guide can name a form's Save button. The map lists each
  sticky action bar in an "Action bar" group; `show_in_app` asks for the button as its own last
  step; `resolveGuide` drops `within: "Action bar"`. The runner (`dashboard/lib/guide-match.ts`)
  tries exact, close, the page's primary submit for a save step, then rows, and never rings a card
  for a button. Gates: unit `guide-match`, `assistant-guide`; `verify:billy` § S.
- **2026-11-10 (fix/billy-action-preview)** — A change shows what it changes; an empty one never
  reaches Confirm. `action-rules.ts`: a create needs its fields (OpenAPI `required` plus
  `MEANING_RULES`), an update is read as the member and sends only changed fields (`UPDATE_READS`,
  before → after on the card), `NO_BODY_OPS` lists the operations that may run empty and the
  sentence their card shows, and `fitError` refuses a create of another kind of record than the
  member asked for or than the Show me guide of the turn. Confirm checks the stored proposal again
  (`storedRefusal`, 422). The card: record icon + title, Live chip and line, no Confirm when a
  create or update has no field. The dock keeps the open conversation per member and business in
  sessionStorage and resumes it. Gates: unit `assistant-action-rules`, `verify:assistant` § P,
  `verify:billy` § Q, `verify:assistant-live` actions 6/6.
- **2026-11-09 (fix/support-notify-outbox)** — Support notices go out at once. The back-office's
  minute poll (`support_notify`) is gone: a member's request or reply queues `support_notice_send`
  (chat + email) in its own transaction (0513, `support-notify.ts`), and the engine worker sends it
  within seconds, retrying a failed channel. The chat line no longer names the plan. Gates:
  `verify:assistant` § S (one post and one email per message, a failed post retried), unit
  `assistant-support.test.ts`.
- **2026-11-09 (feat/billy-support)** — Billy as the support agent (Cloud only, 0512, not
  deployed). Billy answers first and offers a handoff when the member asks for a person, it
  cannot answer, or a request failed without a reason: `propose_support_request` drafts a card
  the member checks, edits (subject, text, attached items, a screenshot) and sends; the model
  never sends it. Staff are told by the back-office worker (chat + email); staff replies appear in
  the panel's Support requests view, signed "Two Minute Billing support", with an unread dot and an
  email. Prompt rules: no promise of a refund, credit, fix or date; never say a person saw it.
  New `redactSecrets` in `leaks.ts`. The launcher moved from the rail to a bottom-right bubble with
  a once-per-record-type nudge. Gates: `verify:assistant` 60/60 (§ S), unit
  `assistant-support.test.ts`.
- **2026-11-09 (fix/billy-quiet-steps)** — Research never reaches the browser (`visibility.ts`):
  help search, screen search, the source check and API-reference reads stream no step and no
  output, and are cut from returned messages; raw tool output is sent only for tools the panel
  draws as a card, and the panel's "View data" is gone. The stored row keeps everything.
- **2026-11-09 (feat/billy-action-wording)** — The confirm card reads the way the dashboard does,
  for all 73 operations: field labels and option labels from the matching form ("Cancel at end of
  current term", "Issue prorated credits", "Exclude from dunning"), dates as `19-Dec-2026 05:30`
  in the business's zone (was a unix timestamp), items as "Pro Monthly × 2" (was JSON with a
  price id), names for customers, invoices, credit notes, prices, coupons, products, meters,
  credit units, payment methods, subscription items, contacts, shipping addresses and dunning
  policies. Previews use the dashboard's figure names; a cancel preview splits credit the way the
  cancel dialog does. Payment requests now set the card's currency. New `action-lines.ts`;
  coverage test `test/unit/assistant-action-coverage.test.ts` renders every operation from its
  API schema. What is sent is unchanged.
- **2026-11-09 (feat/ai-spend-embeddings)** — Docs searches from a turn carry the organization
  (`ToolContext.organizationId`), so their query embeddings are recorded against it in
  `assistant_embedding_usage` (assistant-docs). That table is separate from `assistant_usage`:
  embeddings never count toward the allowance, the token cap or the per-member limits
  (`verify:assistant-allowance` § F). The token-cost arithmetic is `tokensCostFixed12`
  (model-prices), shared with the embedding record.
- **2026-11-09 (fix/billy-action-refresh)** — A confirmed change refreshes the page behind the
  panel (`router.refresh()`), so the record shows the new value at once. The confirm card says a
  per-subscription credit cap the way the screen does ("Never auto-apply here", "Follow the
  business setting", "Auto-apply up to ₹X per invoice"), not "Max excess payment usage $0.00",
  and amounts use the record's currency (an INR subscription in a USD business showed "$").
- **2026-11-09 (fix/billy-guides-first)** — Never cite a developer page or the API reference to a
  member who did not ask about them; dashboard steps first. (An owner asking about excess
  payments was linked "Credits and the ledger", a developer concept page.)
- **2026-11-09 (feat/billy-show-me)** — "Show me": `show_in_app` (assistant-only) turns a
  where-do-I answer into a guide the member opens with a click: the screen, then each control
  highlighted with one instruction. `guide.ts` checks it against the dashboard map (a real screen,
  labels on that screen, record ids the turn read or the member's page), so a guide cannot name an
  invented control or record; refusals log `assistant_guide_refused`. Saved in `extras.guide`.
  The instructions ask for it before the answer (tools asked for after the answer were skipped)
  and prefer the record the member is on over a business-wide setting. `MAX_STEPS` 8 → 10.
- **2026-11-09 (feat/billy-code-first)** — The code is described as the complete record of what
  the product does, and the help as incomplete: before saying something is not possible or a
  setting does not exist, the model searches the screens and the code. How-to answers use
  find_screen with search_docs. (An owner was told there is no way to hold excess payments; the
  subscription page has one.)
- **2026-11-09** — The instructions carry a map of the help (one line per page, from
  `assistant-docs/map.ts`, ~2.8k tokens, static so the provider caches it for every organization)
  and tell the model to search in the help's own words and search again (at most three) when the
  results do not answer. `search_docs` from the assistant uses hybrid search.
- **2026-11-08 (later)** — Wider allowlist (audit of the engine's write routes): cancel a payment
  request, edit a contact or shipping address, check a VAT number, payment links, customer portal
  links (tier 1); remove a pending charge or usage record, record usage, item price, spend
  limits, automatic top-up (tier 2, PUT now allowed); finalize or regenerate an invoice, void a
  credit note, record an offline refund / payment-request payment / excess payment, promotional
  credit balance, void a credit grant, wallet top-up (tier 3). `use` hints on near neighbours
  (credit grants vs balance, collect vs retry, void vs write off, cancel vs pause vs skip…).
  The member edits an email card's note (`POST /auth/assistant/actions/:id/edit`, adhoc emails
  only); the card shows the HTML email in a sandboxed frame. A portal link is returned once in
  the confirm response (`share`) and never stored. Gate: `verify:billy` 60/60 (§ H).
- **2026-11-08** — Email actions show the email. New tier-1 `POST emails/send` (a payment
  method request, invoice, payment request or credit note, with a note giving the reason); the
  card carries `email` (to, copies, subject, full text) from `previewAdhocEmail`, which sends
  nothing. A resend card reads the stored email instead of showing its id. Each operation can
  carry a `use` hint for the model; the prompt says resend only repeats an old email. A 200 with
  `ok: false` (relay refused) settles as failed with the relay's reason. Gate: `verify:billy`
  53/53 (§ F).
- **2026-11-07** — **Billy** (0508): the name; follow-up suggestions; questions with options;
  menu tasks (forced first tool); @ mentions; screenshot attachments; answer feedback (and the
  back-office "Billy feedback" page); actions the member confirms (allowlist in three tiers,
  owner switches, second confirmation for money, "via Billy" in the audit trail). Gate:
  `verify:billy` 47/47 (mutation-checked: the via-assistant guard, the money confirmation).
- **2026-11-07** — The allowance per plan (`allowance.ts`, `allowance-notice.ts`, 0507), read
  from the organization row that account billing writes; record/enforce modes; the 80% note and email; the used-up stop with
  next steps; Settings → Assistant shows the included use. Gate: `verify:assistant-allowance`
  20/20 (mutation-checked: the stop, the once-a-month email).
- **2026-11-07** — References: full section text from `search_docs`, `find_screen` (dashboard
  map, ready-made links), `search_source` with the source guard; change requests answered with
  where to do them. `verify:assistant` 42/42.
- **2026-11-07** — Guardrails: scope rules + `decline_request`, decline and abuse logs,
  per-member limits, link verification. `verify:assistant` 35/35; `verify:assistant-live`
  (gpt-6-luna) 53/55 with attacks 10/10, safety 5/5, data 18/18, 0 invented figures, $0.08/run.
- **2026-11-06** — Created (0505, feat/mcp-server). Gate: `verify:assistant` (28 checks with a
  scripted model).
