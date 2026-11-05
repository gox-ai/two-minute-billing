# metrics/dashboards — saved report dashboards

A dashboard is a **named, ordered set of references into the report catalogue**. It stores
report keys and the options each report already accepts; it never copies a report
definition. So a metric whose maths is corrected is corrected on every dashboard that
shows it, and a dashboard cannot drift into being a second, stale catalogue.

Tables: `report_dashboards`, `report_dashboard_tiles` (migration `0262`).

## Why it looks exactly like `list_views`

Ownership, visibility and defaults are the same problem saved list views solved, so this
mirrors that table field for field rather than inventing a second convention:

| Decision | Here |
| --- | --- |
| `business_id` nullable | NULL is an **org-level** dashboard — a layout the caller points at a business when opening it — never "unknown" |
| `owner` | free text (a dashboard user's email, or an API key's public id), not an FK: the writer is not always a `users` row, and it is also the private-visibility key |
| `visibility` | `private` \| `everyone`, with a CHECK constraint so a direct write cannot invent a third value the predicate would read as public |
| `is_default` | per **owner**, not per organization — "my default" is a personal choice even on a shared dashboard |
| uniqueness | both indexes `coalesce` the nullable `business_id`; a plain unique index would treat every org-level row as distinct and let duplicate names through on exactly the dashboards where it is always NULL |
| `is_mine` | resolved server-side from the session actor, never by comparing an email the client holds. Only the owner may rename, re-share, default or delete |

Not evented, not ledgered, hard-deletable: a dashboard is how someone looks at the
figures, never a change to them.

## A tile holds a KEY, and keys can leave the registry

`report_key` is not a foreign key and cannot be — the catalogue lives in code. So it is
validated against `REPORT_BY_KEY` **on write and on read**:

- **On write** the whole combination is checked, not just the key: the range, the
  granularity (and whether the report has a series to re-cut at all) and the `group_by`
  against the report's own `dimensions`. A tile is saved once and opened for months, so
  this is the only moment the operator is there to be told it is wrong.
- **On read** a key that is no longer in the catalogue yields a tile with
  `available: false` and an `error`. The tile still appears and still names its key.
  Dropping it would quietly change what a named dashboard means, and blanking it would
  look like a figure of zero.

`resolveDashboard` therefore returns three tile states through two fields:

| `available` | `report` | `error` | meaning |
| --- | --- | --- | --- |
| `true` | the answer | `null` | resolved |
| `false` | `null` | set | the report has left the catalogue |
| `true` | `null` | set | the report refused these options (a dimension it no longer offers) |

One tile's failure is never the dashboard's: the others still answer.

## The whole-dashboard fetch

`GET /v1/report_dashboards/:id/reports` answers every tile in one request. Per-tile
requests would mean one round trip each, each with its own `as_of` instant — and figures
measured at twelve different moments do not reconcile. Tiles resolve four at a time: a
report is a heavy read, and a dashboard's worth of them at once would land on the pool
together.

Query-level `range` / `currency` / `granularity` are **defaults**, filling in only what a
tile did not pin, so "this dashboard, in EUR" is one parameter rather than a rewrite of
every tile. A dashboard-wide granularity is withheld from a report that has no series to
re-cut — that report would refuse a default it never asked for.

## Positions

`position` is not unique. A reorder names the whole list and rewrites it in one
transaction, which already guarantees the arrangement; a unique index would only force a
shuffle through throwaway positions. Reads break ties on `created_at` so two tiles at one
position cannot swap between requests.

The reorder call takes **every** tile exactly once. A "move tile 3 to index 1" API applied
twice against a stale view produces an arrangement neither operator asked for; a full list
built from a stale dashboard is refused instead.

## Changelog

- **2026-09-18** — new module. `report_dashboards` + `report_dashboard_tiles` (0262), full
  CRUD over `/v1/report_dashboards`, the whole-dashboard fetch, and
  `scripts/verify-report-dashboards.ts`.
- **2026-11-04** — `createDashboard` refuses a person's 51st stored dashboard in an organization (`MAX_DASHBOARDS_PER_OWNER`, counted across businesses and org-level, under an advisory lock; presets are not rows and do not count). 400 from `POST /v1/report_dashboards`. Gate: `verify:report-dashboards` §12.
