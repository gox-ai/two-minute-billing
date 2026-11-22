# assistant-tools — read-only tools for AI assistants (MCP)

> Source: `src/modules/assistant-tools/` · Routes: `src/api/mcp-routes.ts` · Schema: none
> Layer: domain (see docs/architecture/architecture.json)

## Purpose
One catalogue of read-only tools that AI assistants use to answer questions about a business.
The MCP server (`/mcp`) serves it to external clients today; the in-app assistant will use the
same catalogue. A tool never queries the database: it calls existing `/v1` routes in-process
with the caller's own credential, so auth, permissions, RLS, the test/live partition, rate
limits and the request log apply exactly as for any API call.

## Responsibilities
- Describe each tool for a model: name, title, description, zod input, the permission keys
  that decide whether it is listed.
- Call routes through `fastify.inject` (`route-call.ts`); combine several reads into one
  overview where a question needs them together (`get_customer`, `get_subscription`, …).
- Shape results for a model (`shape.ts`): strip invisible characters from every string, cap
  the size by halving `data` arrays and saying how to page.
- Guard `read_api`: a path relative to the pinned business only; no traversal; no documents,
  bulk exports or connection settings.

## Data model
None. No tables.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `TOOLS` | The catalogue (`catalog.ts`) |
| `ToolError` | A failure worded for the reader; becomes an `isError` result |
| `callRoute(app, caller, req)` | One in-process route call with the caller's headers |
| `stripInvisible(v)` / `capResult(v)` | Result shaping |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /mcp/:biz` | MCP Streamable HTTP (stateless, JSON responses), pinned to one business. Tools, two prompts (`monthly_review`, `failed_payment`), one resource (`tmbilling://business`) |
| `POST /mcp` | Same, when the key reaches exactly one business; else 400 naming them |
| `GET`/`DELETE /mcp[/:biz]` | 405 — no server stream, no session |

Auth: `Authorization: Bearer <api key>` only. The key must be kind `api`, read-only (scope
`read`, or a map with no `write`), and hold `mcp:use`. Cookies are dropped before
`authenticate`, so a browser session can never be the credential.

## Events emitted
None (read-only).

## Dependencies
- **Upstream (calls into):** every module whose `/v1` GET routes the tools call (through HTTP,
  not imports); `auth/permissions` for listing.
- **Downstream (called by):** `api/mcp-routes.ts`.

## Invariants & gotchas
- `tools/list` is filtered by the key's grant, but that is presentation: the route enforces
  the permission on every call. `read_api` is listed for every key for that reason.
- `/mcp` and `/mcp/:biz` are in `READ_SCOPE_POSTS`, which is why `mcp:use` is a READ key: the
  JSON-RPC envelope is a POST, and a read-scoped key must be able to send it.
- Each tool call costs 1–4 requests against the key's rate limit (plus the `/mcp` POST).
- In-process calls carry `user-agent: tmbilling-mcp; <client UA>`, so the request log tells
  MCP traffic apart.
- The SDK (`@modelcontextprotocol/sdk` 1.32.2) negotiates up to protocol 2025-11-25.

## Changelog
- **2026-11-18 (feat/customer-zero-balances)** — `credit_balances` in `get_customer` maps the
  API's `balances[]` only. The API now lists a used-up currency at 0 itself, so the fallback that
  added zero rows from the excess-payments list is gone. Billy sees the same rows.
- **2026-11-18 (part 2)** — Each credit bucket is named for a reader. `get_customer` adds the
  customer's excess payments (`include_used`) and `credit_balances` (every currency the customer
  holds or held credit in, zeros stated: the API omits a currency whose balances are 0).
  `leanExcessPayment` gives the model `received_minor` and `still_held_minor` in place of
  `held_minor`, which read as "still held" and was not. `explain_balance` uses the same rows.
  Invoices now carry `refundable_credits_applied_minor` / `excess_payments_applied_minor`.
- **2026-11-18 (fix/excess-credit-and-billy)** — Ids are opaque. Every id input says to use it as
  given (an imported id may have no prefix). A 404 from `must` adds "use the id exactly as it was
  given … do not read a different record in its place". `get_timeline` takes an optional `kind`,
  needed for an id with no prefix. `search_customers` says it is not for a customer whose id
  the turn already has.
- **2026-11-12 (fix/billy-upcoming-by-type)** — `query_records` (`query.ts`): one aggregation
  over ANY list the caller can read, over every matching row. `resource` is a list path (the same
  guard and deny list as `read_api`); `filters` run in the list route; `with_payer` joins each
  row's customer and how they pay (`joinPayers`, once per customer, 8 at a time, 500 customers at
  most); `where` filters the rows read on any dot path (equal without case, one of, gt/gte/lt/lte,
  contains, is_present); `group_by` (≤ 3 paths) and `metrics` (count, count_distinct, sum, avg,
  min, max; ≤ 5) say what to count. Pages of 100 up to `max_rows` (2,000; 5,000 at most) and 8 s;
  `complete: false` says the figures cover the rows read. Groups largest first, 50 at most; a
  `sample` of rows (3). The model is told to use it for any sum, count or breakdown instead of
  adding up a page. Also over MCP (`verify:mcp` F13–F14). Why: every production question so far
  was answered by a tool shaped like that question; this one answers the next question too.
  Same day, from the first production turn on the new tool
  ("upcoming invoices paid through PayPal to reach $170"): the model saw 10 of 100 rows and a
  count per payment type, so it could not answer. `get_upcoming_charges` takes `payment_type`
  (keeps only the rows whose payer pays that way; `read` says how many were read), and
  `totals[].by_payment_type` carries `{count, amount_minor}` per type, not a count.
- **2026-11-12 (fix/billy-quality)** — `list_subscriptions` and `list_invoices` take `with_payer`:
  each row gets its customer's name, email and primary payment method (`withPayers`, one read per
  customer, in parallel), so "who pays by PayPal" is one call, not one per row. `get_customer`
  adds `open_disputes`. `search_docs` takes `audience` (operator | developer), else
  `ToolContext.audience`; `DEVELOPER_CUES` and `ToolContext.question` are gone, because a regex on
  the member's words sent "how do I delete a customer" to the API reference.
  Later the same day: `withPayers` reads 8 customers at a time (`runBounded`). New tools:
  `get_catalog` (lean products, prices, coupons — coupons `{unavailable}` without
  `coupons:view`), `get_upcoming_charges` (active/in_trial/future subscriptions billing in a
  window, default today..+30 in the business timezone, with payers and `totals` per currency by
  payment type; `estimate: true`, recurring amount before tax/usage/discounts),
  `get_collections_queue` (payment_due/not_paid with a retry within `days`, sorted by
  `next_attempt_at` here because the list cannot sort by it; `total_due` per currency) and
  `get_timeline` (events + emails + payments of one record, newest first, 40 at most; each read
  is a `part`, a refused one is named in `notes`). `explain_payment` takes `invoice` or
  `payment` (`pi_`/`txn_`): a transaction leads to its intent and invoice; an intent names no
  invoice, so its first transaction does. Payment results add `payment` and `attempts`. MCP adds
  the prompts `monthly_review` and `failed_payment` and the resource `tmbilling://business`
  (listed only for a key with `settings:view`).
- **2026-11-11 (perf/billy-fast)** — `shapeForModel` (in-app assistant only; MCP unchanged at
  `capResult` 60,000): null and empty fields, `object` tags and metadata over 400 characters out;
  a value shared by every row of a list said once (`same_in_every_row`); lists at 10 rows unless
  the model asked for a limit (`more_rows` says how many were read; `next_cursor` dropped, since
  paging from there would skip rows); capped at 20,000 characters (`MODEL_RESULT_CHARS`) by
  cutting long strings, then halving lists. The routes still read 25 rows, so the panel's cards
  and the stored rows are unchanged.
- **2026-11-10 (feat/transfer-async)** — `get_transfer_status` (`transfers:view`): the open plan or
  running copy of this business's set-up and the latest past copies, with counts and errors. Read
  only; a copy is started only on the Transfer screen.
- **2026-11-09 (feat/ai-spend-embeddings)** — `ToolContext.organizationId` (set by the assistant
  turn and the MCP route); `search_docs`, `find_screen` and `search_source` pass it to
  `searchDocs`, so each query embedding is recorded against the asking organization.
- **2026-11-09 (fix/billy-guides-first)** — In the app, `search_docs` returns guides only unless
  the member's own question is about the API, code, webhooks or an integration
  (`ToolContext.question`, `DEVELOPER_CUES`); no developer page or API reference otherwise, even
  when no guide matches (a note sends the model to the screens and the code). MCP unchanged.
- **2026-11-09 (feat/billy-show-me)** — `find_screen` names the card each match sits in (`cards`)
  and always includes the screen the member is on (`on_this_page`, linked with its real ids) when
  the context has a page; MCP has none. `ToolContext.page` added.
- **2026-11-09 (feat/billy-code-first)** — `search_source` is described as the complete record
  of the product, for any question the help does not answer. `find_screen` returns the controls
  of the matching screen section (≤ 30), found by meaning as well as by keyword.
- **2026-11-09 (later)** — `search_docs` is hybrid over MCP too: the query text is embedded by
  OpenAI, now on the public sub-processor list (`/sub-processors`). `ToolContext.channel` removed
  (nothing reads it).
- **2026-11-09** — `ToolContext.channel` (`assistant` | `mcp`). `search_docs` is hybrid
  (keyword + embeddings) for the assistant and keyword-only over MCP, so an AI app's query text
  is not sent to a model provider. Its description asks for the product's terms and a second
  search when the first misses.
- **2026-11-07** — `find_screen` (also over MCP) and the assistant-only `search_source`
  (`assistantOnly` keeps a tool off MCP). `search_docs` returns whole sections for its top 3.
- **2026-11-06** — Phase 4: `search_docs` and `get_api_reference` (from `assistant-docs`, no
  route: the docs are public, platform-wide data). 19 tools.
- **2026-11-06** — Phase 2: `explain_invoice` and `explain_mrr_change` over the new
  `GET …/invoices/:inv/explanation` and `GET …/mrr_bridge`; `explain_payment` and
  `explain_balance` combine existing reads. 17 tools; `verify:explain` (feat/mcp-server).
- **2026-11-06** — Created: 13 read-only tools, `/mcp` + `/mcp/:biz`, `mcp:use` permission,
  `verify:mcp` (feat/mcp-server).
