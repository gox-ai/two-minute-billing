# request-log — API request log

> Source: `src/modules/request-log/` · Routes: `src/api/request-log-routes.ts` · Schema: `db/schema/request-log.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
What each organization's credentials sent and what we answered: one row per `/v1/*` request, with
the redacted request and response bodies. A debugging aid for integrating developers and support.
It stores none of the authoritative records (idempotency keys, events, audit rows, gateway calls);
it links to them by trace id and idempotency key.

## What is logged
- API-key requests, reads and writes; dashboard (operator session or dashboard key) writes, with
  the member. `kind` follows the read-scope rule (`requestKind` in `platform/auth.ts`).
- Refusals after the credential resolves: 429, read-scope 403, restricted / live-access 403,
  `idempotency_required` 400, idempotency 409s, validation 400s, 5xx.
- Not logged: no resolved organization (bad key 401, unrouted 404, 2FA-enrolment 403), anything
  outside `/v1/*` (health, `/auth/*`, portal, checkout, inbound webhooks), OPTIONS, routes with
  `config.requestLog = "off"` (this module's own reads).

## Capture → flush
- `capture.ts`: `onRequest` mints the uuidv7 id and the `Request-Id: req_<32 hex>` header;
  `finishAuthentication` (`noteRequestLogAuth`), `resolveBusiness` (`noteRequestLogBusiness`) and
  the `idempotency` preHandler (`noteIdempotencyOutcome`) fill the request slot; `onSend` keeps a
  reference to the serialized response when it is stored; `onResponse` pushes one object. No hook
  awaits or throws.
- `flush.ts`: in-process buffer drained every 1 s or 250 rows, multi-row insert on `systemDb`
  (rows span organizations). Ceiling 5,000 rows / 32 MB: past it, bodies drop; past twice it, rows
  drop (`request_log_dropped` warn, at most once a minute). A failed batch gets one retry, then is
  dropped. Graceful shutdown flushes (`startRequestLogFlush` disposer in `src/index.ts`).
- `redact.ts`, applied at flush: key words (`password`, `secret`, `token`, `api key`, …; plural
  `tokens` kept), everything under `credentials` leaf by leaf, value shapes (our token prefixes,
  `Bearer`, JWTs, Luhn PANs), then caps (leaf > 2,048 chars, body > 32 KB → 2 KB preview).
  Names, emails and addresses are kept (user decision 3).

## Route config
`config.requestLog`: `off` (never logged), `meta` (bodies only on status ≥ 400 — usage
ingestion), `no_response` (response never stored — webhook endpoint create / rotate secret).
`idempotentNoStore` routes are treated as `no_response`. **Any new route that returns a one-time
secret must carry one of the two.**

## Data model
`api_request_logs` (0392): RLS `org_isolation`, `tmbilling_app` has SELECT/INSERT/DELETE (no
UPDATE). Indexes: `(org, created_at desc, id desc)`, `(org, idempotency_key)`, `(org, trace_id)`,
`(org, customer_id, created_at desc)`.

## Public surface
| Function | What it does |
|---|---|
| `registerRequestLog(app, { kindOf })` | installs the hooks |
| `listRequestLogsPage` / `getRequestLog` | cursor list and detail (+ `related`) through `withTenant` |
| `deleteCustomerRequestLogs` | erasure, called by `clearPersonalData` |
| `flushRequestLogs` / `startRequestLogFlush` / `requestLogStats` | the writer |

## API routes
| Method · Path | Purpose |
|---|---|
| GET `/v1/request_logs` | list (GUIDE §3.4); `requirePerm("developer")`; keys gated to their mode |
| GET `/v1/request_logs/:id` | one request, bodies, same-key requests, events / audit / gateway calls by trace id |

## Retention
`modules/ops/retention.ts` `apiLogDatasets`: writes 90 days, reads 30 days
(`api_log_writes_days` / `api_log_reads_days`, 0393). Runs in every organization mode, Off and Dry
run too (user decision 2); 0 keeps the data.

## Verify
`verify:request-log` (capture, redaction, no-store, caps, failure path, idempotency links,
refusals, exclusions, RLS + mode gate, filters, erasure, shutdown flush); `verify:retention`.

## Changelog
- **2026-10-25** — Created (design L): capture, redaction, buffered writer, read API, retention,
  erasure, `Request-Id` header.
