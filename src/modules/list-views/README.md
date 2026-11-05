# list-views

Saved list views, also called **segments**: the named entries in the
`All Subscriptions ▾` dropdown on every list screen.

## Why it exists

Every list screen already had a filter builder, but nothing to keep. An operator
answering "which INR subscriptions are renewing next week and owe more than ₹50k"
rebuilt the same five conditions every morning, and a finance team that agreed on a
definition of "overdue" had no way to share it. The built-in segments hard-coded in each
table covered five or six cases and could not be added to without a deploy.

Segments are also the other half of a rich filter: the widened operator vocabulary in
`src/platform/list-query.ts` (`in`, `between`, `in_last`, `gte`…) makes conditions worth
composing, and composing them is only worth it if the result survives the session.

## Shape

**One table for every list**, keyed by an `entity` slug — the same key the dashboard's
`/api/lists/<entity>` proxy uses. The legal keys are `LIST_VIEW_ENTITIES` in
`entities.ts`, not a DB enum: adding a list is then one line rather than a migration
(the trade-off `COMMENT_RESOURCE_TYPES` already makes).

A view stores the whole way of looking at a list, not just its filters:

| column | holds |
|---|---|
| `filters` | `{field, op, value}[]` — the API's own grammar, verbatim |
| `search` | the free-text box |
| `sort_field` / `sort_desc` | the sort |
| `hidden_columns` | the column choice; NULL = "the list's defaults" |

**`business_id` is nullable**, unlike most tenant-scoped tables. Two lists in the product
are org-wide — the `/audit` activity log, and the billing clock, which crosses tenants —
so their views have no business to hang off. NULL therefore means "an org-level list",
not "unknown", which is why both uniqueness indexes `coalesce` it instead of relying on
NULL-distinctness: a plain unique index would treat every NULL row as distinct and let
duplicates through on exactly the lists whose `business_id` is always NULL.

**`owner` is free text** — a dashboard user's email, or an API key's public id — for the
same reason `comments.author` and `audit_logs.actor` are: the writer is not always a
`users` row, and an FK would make an API-created view unattributable. It is also the
`private` visibility key, so `createListView` **refuses** a save it cannot attribute
rather than filing it under a `system` sentinel: an unattributable "private" view would
be visible to every other unattributable caller, which is the opposite of the promise.

### One grammar, three places

A view's `filters` are the same `field / op / value` triples that the list API takes as
`?<field>[<op>]=<value>` and the dashboard writes into the address bar as
`?filter=field:op:value`. Nothing translates between them. A view that needed translating
would drift from what the endpoint accepts, and the first symptom of that drift is a
segment showing the wrong rows under a name people trust.

That is also why filters are validated **against the target list's own allow-list** on
save (`validateFilters`, reusing each module's `*_FILTER_OPS`): saving is the only moment
the operator is present to be told something is wrong. Browser-filtered lists (catalog,
tax regions…) have no engine allow-list, so only the global operator vocabulary is
checked there — `fieldOpsFor` returns null and the list's own `filterFields` is the
field authority.

## Ownership, sharing and defaults

- `visibility: 'private'` — only `owner` sees it. `'everyone'` — the whole organization.
- **Only the owner may edit, re-share or delete**, including a shared view: a segment a
  finance team relies on must not be silently redefined by whoever opened it last. The
  answer to "this view, but with INR too" is `duplicateListView`, which makes a private
  copy the caller owns.
- `is_default` is **per owner**: "the view I land on" is a personal choice, and
  `list_views_default_uq` is a partial unique index enforcing one per operator per list.
  It therefore only applies to views you own — a colleague's shared view cannot be your
  default, and the dashboard offers Duplicate there instead of a dead "set default".
- Reads and 404s never distinguish "no such view" from "not yours". Telling them apart
  would disclose that a colleague holds a private view by that id.

Intentionally **not evented and not ledgered**, like `comments`: a view is how someone
looks at the data, never a change to it, and no webhook subscriber should react to
somebody saving a filter.

## Routes

Org-level with an **optional** `business`, not the usual `/v1/businesses/:biz/…`
nesting — a business-scoped family could not express the two org-wide lists at all.

| route | notes |
|---|---|
| `GET /v1/list_views?entity=&business=` | Your views plus everything shared. Not paginated (a handful per list). |
| `POST /v1/list_views` | 409 on a duplicate name, 400 with a sentence naming the bad field. |
| `PATCH /v1/list_views/:id` | Partial: an absent key is untouched, `null` clears it. |
| `POST /v1/list_views/:id/duplicate` | The copy is private and owned by the caller. |
| `DELETE /v1/list_views/:id` | A real delete — nothing was posted to the ledger. |

**No `requirePerm` gate, deliberately.** A view holds a filter definition, never data,
and every role that can open a list can already see everything a view would narrow.
Gating it on `ops` would stop a read-only analyst from saving their own segment, which is
the one thing they most need. Sharing is ungated for the same reason: it publishes a
query, not rows.

Dashboard: `components/patterns/list-views.tsx` (the dropdown, the Save and Manage dialogs, and
the `useSavedViews` hook), `lib/api/list-views.ts` and the `app/api/list-views` proxy —
which passes **no owner of its own**, so the engine attributes every view to the
signed-in operator from the session. `serializeListView` states `is_mine` per row rather
than making the browser compare emails; "who am I" is a question only the engine can
answer correctly.

## Gate

`pnpm verify:list-views` (`scripts/verify-list-views.ts`, in `verify:all`). It executes
**every operator against Postgres** rather than only rendering the SQL, and asserts
0219's constraints and both coalesced uniqueness indexes really exist. That is not
ceremony: it is what caught `in_last`/`in_next` emitting `date + $n` with an untyped
parameter, which Postgres rejects outright — a typecheck and an offline SQL render both
called it fine.

## Changelog

- **2026-11-03** — Filter fields and value aliases are matched against own keys only (`constructor`, `__proto__`).

- **2026-10-13** — `clock_ticks` and `due_work` are no longer list entities: no screen in this
  repo lists them. Rows already saved for them stay in the table and are never served.
- **2026-09-30** — Renamed enum values are stored in the current spelling: a view saved with
  `transactions.status` `success`/`failure`/`late_failure` or `invoices.dunning_status` `success`
  is written as `succeeded`/`failed`/`late_failed` (`normalizeFilterValues`). 0321 rewrote
  existing views the same way.
- **2026-09-18 (latest)** — **the `ar_bucket` check reads a rung NAME, not a fixed ladder.** The
  ageing report can now be rebuilt at 7/15/30/60-day rungs, so `1–15 days` is a rung a report
  really printed; validating against the standard ladder would have refused the very view a
  reader saved from that screen. A name that is not a rung at all (`31-60 days`, hyphenated) is
  still refused on save.
- **2026-09-18** — **`validateFilters` now checks the ONE closed-vocabulary value it
  can**: `ar_bucket` on the invoices list compares a derived ageing-rung NAME, so a typo used to
  save happily and then 400 on every open of a view someone had named. Everything else stays
  shape-only, for the reason the comment there gives.
- **2026-09-07** — **`shadow_events` and `cancel_decisions` removed** from `ORG_ENTITIES`
  with the shadow programme. Both were org-level, `business_id`-NULL entities; any saved view a
  user had stored against either now names an entity the registry does not know.
- **2026-08-31** — created. Closes the "saved, shareable segments" half of the
  list-filter gap (`docs/PROGRESS.md`); the operator half is the widened
  vocabulary in `src/platform/list-query.ts` and the rebuilt builder in
  `dashboard/components/patterns/list-filters.tsx`.
