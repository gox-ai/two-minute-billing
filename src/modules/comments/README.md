# comments

Operator notes pinned to a billing record.

## Why it exists

The same notes widget belongs on invoices, credit notes, customers and
subscriptions. We had none, and it was the single blocker shared by the most
detail-screen gaps: three detail sections plus the "Add a comment (optional)"
field on all four credit-note dialogs.

## Shape

**One polymorphic table**, not one per record type. `resource_type` +
`resource_id` hold the record's **public id** (`inv_…`, `cn_…`, `cus_…`),
matching how `audit_logs` and `events` already point at resources — so the same
`?resource_id=` read pattern works across all three, and a new screen wanting a
notes box needs no migration.

There is deliberately **no FK**: the target table varies by type and public ids
are stable. Deleting a business cascades; individual billing records never
hard-delete, so orphans are not a real case.

Unlike `audit_logs`, comments are **mutable** — an operator can edit or delete
their own note — hence the `bump_row_version` trigger.

Comments are **not evented and not ledgered**: annotation is not domain state,
and no webhook subscriber should react to one.

## Surface

| Route | Notes |
|---|---|
| `GET /v1/businesses/:biz/comments?resource_type&resource_id` | Oldest first. **Not paginated** — a record accumulates a handful of notes, not thousands. If that stops being true, move it to the shared cursor helper in `platform/list-query.ts`. |
| `POST /v1/businesses/:biz/comments` | Author resolved from the ambient event context (api key id / dashboard user), not passed by the caller. |
| `PATCH /v1/businesses/:biz/comments/:id` | Body only. |
| `DELETE /v1/businesses/:biz/comments/:id` | A real delete — safe here, since nothing was posted to the ledger. |

Dashboard: `components/comments/comments-card.tsx` renders the box on any record;
`lib/api/comments.ts` wraps the routes.

## Changelog
- **2026-09-30** — `coupon`, `coupon_set` and `product_group` joined the resource types. The
  existence lookup now names its id column per type, because a coupon's code is its id.
- **2026-08-21** — `product` and `price` joined the resource types, and `createComment`
  now **checks the target exists in this business** before inserting — a `resource_id`
  naming no record is a 404 (`CommentResourceNotFoundError`, a `CommentError` subclass so
  existing catch sites still see a comment error). There is no FK by design (the target
  table varies by type), which had left `resource_id` as free text that accepted a typo
  and buried the note, and accepted another tenant's public id outright. The check applies
  to all six types, so it is a behaviour change for the original four.

- **2026-08-01** — created, closing the comments gap on invoices and credit notes.
  Customers and subscriptions can adopt `CommentsCard` as-is; no backend work needed
  for them.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-30** — `getComment` + `GET …/comments/:id`; `listCommentsPage` backs a paged list (business-wide when `resource_type`/`resource_id` are omitted, `created_at[op]` filters, `sort_by`, keyset cursor). The exact `resource_type`+`resource_id` request stays the unpaged per-record list. Authorship stays server-side — no caller-supplied author.
