import type { FastifyReply, FastifyRequest } from "fastify";
import { updateTraceContext } from "@/platform/trace";
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { pinRequestClock } from "@/platform/clock";
import { timeTravels } from "@db/schema";
import { z } from "zod";
import { getBusinessByPublicId } from "@/modules/tenancy/service";
import {
  filterValueError,
  MAX_LIST_LIMIT,
  requestExactTotals,
  type FilterKind,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { consumePublicRateLimit, type PublicLimitRule } from "@/platform/rate-limit";
import { createLogger } from "@/platform/logger";
import { sessionTokenFromHeaders } from "@/platform/auth";
import {
  apiKeyHolds,
  permissionDef,
  type PermissionDef,
  type PermissionKey,
} from "@/modules/auth/permissions";
import { unknownParamsIn } from "./strict-params";
import { recordBuyerRejection } from "@/modules/ops/buyer-rejections";
import { noteRequestLogBusiness } from "@/modules/request-log/capture";

/** Same service name `src/index.ts` uses for the request/response line, so a rejection
 *  and the 400 it produced group together in the log viewer. */
const apiLog = createLogger("api");

/**
 * Resolve the :biz path param to a business in the authed org, or reply 404.
 *
 * The `await` on the reply is load-bearing, not decoration. Callers use
 * `if (!business) return` — a bare return — and on write routes the async
 * `idempotencyOnSend` hook means the 404 is still in flight when the handler
 * resolves. Fastify then sees `payload === undefined && reply.sent === false` and
 * starts a SECOND send, whose `writeHead` throws an uncaught ERR_HTTP_HEADERS_SENT
 * that kills the process (fixed 2026-08-03). `FastifyReply` is thenable, so awaiting
 * it parks here until the response has actually been flushed — after which Fastify's
 * own `reply.sent` gate is accurate and no second send is attempted.
 * `platform/reply-guard.ts` is the belt to this braces.
 */
export async function resolveBusiness(req: FastifyRequest, reply: FastifyReply) {
  const bizId = (req.params as { biz: string }).biz;
  const business = await getBusinessByPublicId(req.organization!.id, bizId);
  if (!business) {
    await reply.code(404).send({
      error: { type: "invalid_request_error", message: `No such business: ${bizId}` },
    });
    return null;
  }
  // The business sub-scope, for the same reason auth binds the organization: every
  // line logged for the rest of this request carries it, and cloud-logging promotes
  // it to an indexed label. Set here rather than in `authenticate` because THIS is
  // where a `:biz` route parameter becomes a real, existence-checked business.
  updateTraceContext({ businessId: business.publicId });
  noteRequestLogBusiness(req, business);
  // A time-travelled test business records this request's rows at its simulated instant,
  // matching `businessWallClock`. Live businesses cannot have time travel: no lookup.
  if (business.livemode === "test") {
    const [tm] = await systemDb
      .select({ simulatedNow: timeTravels.simulatedNow })
      .from(timeTravels)
      .where(eq(timeTravels.businessId, business.id))
      .limit(1);
    if (tm?.simulatedNow) pinRequestClock(business.id, tm.simulatedNow);
  }
  return business;
}

/**
 * Values quoted in a validation message, replaced with a placeholder.
 *
 * The refinements in `address-validation.ts` quote the offending input — `"IN-TN" is not
 * a valid state code`, `"9485768578" is not a valid phone number` — which is exactly what
 * a developer wants and exactly what must not reach a log. This is a PUBLIC endpoint: the
 * quoted value is whatever a buyer typed, so it can be their phone number, their postal
 * code or their GSTIN, and it would then sit in Cloud Logging for the retention period.
 *
 * The field name plus the RULE that failed is what makes a rejection actionable; the
 * offending value is already in front of the person who typed it. So the rule is kept and
 * the value is dropped.
 */
const redactQuoted = (message: string): string => message.replace(/"[^"]*"/g, '"…"');

/** At most this many reasons go into `message`; `details` keeps every one. */
const MAX_REASONS = 5;

/** `address.phone: <reason>; email: <reason>` — one entry per distinct issue. */
export function issueSummary(err: z.ZodError): string {
  const parts = err.issues.map((i) =>
    i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message,
  );
  const unique = [...new Set(parts)];
  const more = unique.length > MAX_REASONS ? `; and ${unique.length - MAX_REASONS} more` : "";
  return unique.length
    ? unique.slice(0, MAX_REASONS).join("; ") + more
    : "The request body is not valid";
}

/** Standard 400 for a failed Zod body parse, or a plain validation message. */
export function badRequest(reply: FastifyReply, err: z.ZodError | string) {
  if (typeof err === "string") {
    apiLog.warn("request rejected", { event: "request_rejected", reason: err });
    recordBuyerRejection(reply.request, redactQuoted(err), {});
    return reply.code(400).send({ error: { type: "invalid_request_error", message: err } });
  }
  const unknown = unknownParamsIn(err);
  if (unknown.length) {
    apiLog.warn("request rejected", { event: "request_unknown_parameters", params: unknown });
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: `Unknown parameter: ${unknown.join(", ")}`,
        param: unknown[0],
      },
    });
  }
  // Typed explicitly: zod's flattened shape widens to `{}` through `Object.entries`,
  // so the per-field arrays lose `.map` without it.
  const fieldErrors = z.flattenError(err).fieldErrors as Record<string, string[] | undefined>;
  /**
   * Logged HERE because this is the single funnel every zod rejection in the API passes
   * through — one line covers every route rather than each one remembering.
   *
   * Until now the reason went ONLY into the response body, i.e. to the client and nowhere
   * else. `onResponse` logged the 400 with its route and status, so the shape of the
   * failure was visible while the cause never was — and on a hosted checkout the client is
   * a buyer who will not be reporting it. A tmbilling checkout rejected every address
   * submission for a missing `email` on 2026-08-27 and the server had recorded nothing but
   * `POST /checkout/v1/customer status: 400`.
   *
   * `warn`, matching what `onResponse` uses for a 4xx: a client sending a bad body is not
   * a fault of ours, but it is the thing you search for when someone says "it won't save".
   */
  const redacted = Object.fromEntries(
    Object.entries(fieldErrors).map(([field, msgs]) => [field, (msgs ?? []).map(redactQuoted)]),
  );
  apiLog.warn("request body rejected", { event: "request_body_rejected", fields: redacted });
  const message = issueSummary(err);
  recordBuyerRejection(reply.request, redactQuoted(message), redacted);
  return reply.code(400).send({
    error: {
      type: "invalid_request_error",
      // The reasons themselves, so a caller that shows only `message` still says what to correct.
      message,
      // NOT redacted on the wire. The response goes to the caller who submitted the
      // value, so echoing it back tells them which entry to correct — the concern is
      // persistence in our logs, not the round trip.
      details: fieldErrors,
    },
  });
}

/** Standard 404 for a missing resource. */
export function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: { type: "invalid_request_error", message } });
}

/** 409 for optimistic-concurrency conflicts (stale resource_version on PATCH). */
/**
 * Refuse the request with 429 if it is over a public rate limit (W3). Returns true when
 * the caller has been refused and the handler must stop.
 *
 * Lives here rather than in `platform/rate-limit.ts` because it is the HTTP half — the
 * status code, the envelope and the four headers — while that module is the counter.
 * Shared by the credential routes in `auth-routes.ts` and the buyer-facing exchange in
 * `customer-portal-routes.ts`; it was private to the first until the second needed the
 * identical behaviour, and two copies of a refusal is how the two drift into answering
 * differently.
 *
 * Called INSIDE handlers rather than as a preHandler because some limits key on a field
 * in the BODY (the submitted email), and a preHandler runs before the body is parsed —
 * which would leave only the client address to count, the weaker of the two axes.
 *
 * The `X-RateLimit-*` trio and `Retry-After` go out on every call, refused or not, so an
 * honest client can back off before it is refused rather than after.
 */
export async function refusedByRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  // The whole rule, not a hand-picked subset. It used to be `{ scope, keys }`, so adding
  // `failClosed` to PublicLimitRule (audit M2) made every call site here a type error —
  // the narrow copy has to be widened by hand every time the rule grows. Excess-property
  // checking caught it this time because the call sites pass object literals; a rule built
  // as a variable first would have type-checked and quietly lost the field.
  rule: PublicLimitRule,
  /** Overrides the generic sentence, e.g. where the window is an hour, not a minute. */
  message = "Too many requests. Wait a moment and try again.",
): Promise<boolean> {
  const d = await consumePublicRateLimit(rule);
  reply.header("x-ratelimit-limit", String(d.limit));
  reply.header("x-ratelimit-remaining", String(d.remaining));
  reply.header("x-ratelimit-reset", String(Math.floor(d.resetAt.getTime() / 1000)));
  if (d.allowed) return false;
  reply.header("retry-after", String(d.retryAfterSeconds));
  // Generic on purpose. "Too many attempts for this email" would confirm the address is
  // one we know — the enumeration oracle these routes are careful not to be.
  reply.code(429).send({
    error: { type: "rate_limit_error", message },
  });
  return true;
}

export function conflict(reply: FastifyReply, message: string) {
  return reply.code(409).send({ error: { type: "conflict_error", message } });
}

/**
 * 502 for a GATEWAY CONDITION WE CANNOT RESOLVE — the HTTP half of
 * `ProviderIndeterminateError` (`providers/types.ts`).
 *
 * `retriable: true` is in the body because that is the whole point of separating this
 * from a refusal: nobody did anything wrong, so the caller's correct move is to try
 * again, and a 400 would have told them to change a request that was already right.
 *
 * ⚠️ 502 and not 503 or 504. 503 would claim WE are down, which is untrue — the engine
 * answered, it is what the gateway told us that is inconclusive; 504 fits only a
 * provable timeout, and the commonest case here is a gateway that replied promptly with
 * something we could not act on. One status code, with `type` carrying the precision.
 *
 * Logged at `error`, unlike the 4xx neighbours' `warn`: a 400 is the caller's bad
 * request, this is our operation ending without an answer, and it is the line an
 * operator searches for when a Void did nothing.
 */
export function badGateway(reply: FastifyReply, message: string) {
  // The sentence itself is the reported failure (the logger's `error` takes the error
  // first, and gives a string-reported one a stack from this call site), so the reason
  // lands under `error_message` rather than being buried in `debug_info`.
  apiLog.error(message, { event: "gateway_indeterminate" });
  return reply.code(502).send({ error: { type: "gateway_error", message, retriable: true } });
}

// ── Paginated list routes ─────────────────────────────────────────────────────

/** Parsed, validated list query — hand straight to the module's list service. */
export interface ParsedListQuery {
  limit?: number;
  startingAfter?: string;
  search?: string;
  sortField?: string;
  sortDesc?: boolean;
  filters: ListFilter[];
  /** `?include_deleted=true`. Only meaningful where the route declared `includeDeleted: "honoured"`. */
  includeDeleted: boolean;
}

/**
 * Query keys every list endpoint accepts, regardless of route: paging + free-text search.
 * `offset` is `starting_after` under a second name — the same opaque token, returned as
 * both `next_cursor` and `next_offset`.
 */
const RESERVED_LIST_PARAMS = ["limit", "starting_after", "offset", "q", "total"] as const;

/**
 * The `<field>[<op>]` query-key shape.
 *
 * ⚠ The FIELD half allows digits; the operator half does not. That asymmetry is
 * load-bearing: a custom field's `api_name` is validated as `/^[a-z][a-z0-9_]*$/`
 * (`custom-fields/service.ts`), so `cf_tier2` is a perfectly legal field — and with the
 * old `[a-z_]+` here it was rejected one step too early, as an "Unknown query
 * parameter", before the allow-list ever got to say whether the field existed. The
 * operator half stays digit-free because the operator vocabulary is closed and none of
 * them contain a digit.
 *
 * Widening the field half is safe: an unrecognised field is still refused by the
 * `allow.filterOps` check below, which is where that refusal belongs.
 */
const FIELD_OP_KEY_RE = /^([a-z][a-z0-9_]*)\[([a-z_]+)\]$/;

/**
 * Parse the shared list query — `limit`, `starting_after`, `q`,
 * `sort_by[asc|desc]=<field>` and `<field>[<op>]=<value>` —
 * validating everything against the caller's allow-lists.
 *
 * Returns `null` **after replying 400**: an unknown query parameter, filter
 * field, operator or sort key is a caller bug, and answering it with a
 * silently unfiltered list is how someone ends up refunding the wrong
 * customer — measured 2026-08-03: `GET /invoices?subscription=<id>` returned
 * all 275 invoices for a business instead of the 2 belonging to that
 * subscription, because the unrecognised `subscription` key was dropped
 * rather than rejected. The message names what is supported so the mistake
 * is self-correcting.
 */
/**
 * Why one filter is refused, or null. The field, the operator AND the value's shape:
 * `status[in]=` with nothing after it, `mrr[between]=1000` with one bound,
 * `created_at[on]=31/08/2026` — each used to reach SQL, where the best case is a 500 and
 * the worst is a condition that matches everything under a filtered label.
 */
export function listFilterError(
  f: ListFilter,
  allow: { filterOps: Record<string, readonly string[]>; filterKinds?: Record<string, FilterKind> },
): string | null {
  // Own keys only: `constructor` or `__proto__` must not resolve through the prototype.
  const ops = Object.hasOwn(allow.filterOps, f.field) ? allow.filterOps[f.field] : undefined;
  if (!ops)
    return `Cannot filter on '${f.field}'. Filterable: ${Object.keys(allow.filterOps).join(", ")}`;
  if (!ops.includes(f.op))
    return `Operator '${f.op}' is not supported on '${f.field}'. Supported: ${ops.join(", ")}`;
  const kind = allow.filterKinds?.[f.field];
  const problem = kind ? filterValueError(kind, f.op, f.value) : null;
  return problem ? `Invalid value for '${f.field}[${f.op}]': ${problem}` : null;
}

export function parseListQuery(
  req: FastifyRequest,
  reply: FastifyReply,
  allow: {
    /** field → operators it accepts. */
    filterOps: Record<string, readonly string[]>;
    /**
     * field → column kind, for VALUE validation (`kindsFromSpecs` on the module's
     * column map). Optional only so a route that filters on virtual fields with no
     * single kind can omit it; pass it wherever there is a column map, because
     * without it a malformed value is caught by Postgres (a 500) rather than here.
     */
    filterKinds?: Record<string, FilterKind>;
    sortFields: readonly string[];
    /**
     * Route-specific convenience query params the ROUTE reads directly off
     * `req.query` — not through the generic `field[op]` grammar — e.g.
     * invoices' `?customer=`/`?subscription=` scopes, transactions' legacy
     * flat `?type=`/`?status=`/`?gateway=`/`?invoice=`/`?customer=`. Each
     * route has a DIFFERENT legal set, so this is a per-call allow-list
     * rather than one hard-coded union. Always-legal reserved keys (`limit`,
     * `starting_after`, `q`, `sort_by[asc|desc]`) don't need to be listed —
     * they're accepted everywhere and validated below.
     */
    bareParams?: readonly string[];
    /**
     * How this list answers `?include_deleted=`. `none`: nothing listed here can be
     * deleted, so the flag is accepted and changes nothing. `honoured`: the route reads
     * `includeDeleted` and widens to the rows it otherwise hides. Omitted: the key stays
     * unknown (400) — a list that hides rows must never accept the flag as a no-op.
     */
    includeDeleted?: "none" | "honoured";
  },
): ParsedListQuery | null {
  const q = req.query as Record<string, string | undefined>;

  // Reject any query key that is neither a reserved param, a route-declared
  // convenience param, nor the generic `field[op]` grammar. Must run BEFORE
  // anything below reads a key, so a typo'd or unsupported filter 400s instead
  // of silently narrowing nothing.
  const bareAllow = new Set<string>([
    ...RESERVED_LIST_PARAMS,
    ...(allow.bareParams ?? []),
    ...(allow.includeDeleted ? ["include_deleted"] : []),
  ]);
  for (const key of Object.keys(q)) {
    if (bareAllow.has(key)) continue;
    if (key === "sort_by[asc]" || key === "sort_by[desc]") continue;
    if (FIELD_OP_KEY_RE.test(key)) continue; // `<field>[<op>]` — validated below
    badRequest(
      reply,
      `Unknown query parameter '${key}'. Use '<field>[<op>]=<value>' to filter, or one of: ${[...bareAllow].join(", ")}.`,
    );
    return null;
  }

  if (q.limit != null) {
    const n = Number(q.limit);
    if (isNaN(n) || !Number.isInteger(n) || n < 1) {
      badRequest(reply, "limit must be a positive integer");
      return null;
    }
    if (n > MAX_LIST_LIMIT) {
      badRequest(reply, `limit must be ${MAX_LIST_LIMIT} or less`);
      return null;
    }
  }

  if (q.include_deleted != null && q.include_deleted !== "true" && q.include_deleted !== "false") {
    badRequest(reply, "include_deleted must be 'true' or 'false'");
    return null;
  }
  // `total=exact` counts past the 10,000 cap, for a total shown as a figure.
  if (q.total != null && q.total !== "exact" && q.total !== "capped") {
    badRequest(reply, "total must be 'exact' or 'capped'");
    return null;
  }
  if (q.total === "exact") requestExactTotals();
  if (q.starting_after && q.offset && q.starting_after !== q.offset) {
    badRequest(reply, "Pass either starting_after or offset, not both.");
    return null;
  }

  let sortField: string | undefined;
  let sortDesc: boolean | undefined;
  for (const dir of ["asc", "desc"] as const) {
    const v = q[`sort_by[${dir}]`];
    if (v == null) continue;
    if (!allow.sortFields.includes(v)) {
      badRequest(reply, `Cannot sort by '${v}'. Sortable: ${allow.sortFields.join(", ")}`);
      return null;
    }
    sortField = v;
    sortDesc = dir === "desc";
  }

  const filters: ListFilter[] = [];
  for (const [key, value] of Object.entries(q)) {
    const m = FIELD_OP_KEY_RE.exec(key);
    if (!m || key.startsWith("sort_by[") || value == null) continue;
    const [, field, op] = m;
    const problem = listFilterError({ field: field!, op: op!, value }, allow);
    if (problem) {
      badRequest(reply, problem);
      return null;
    }
    filters.push({ field: field!, op: op!, value });
  }

  return {
    limit: q.limit != null ? Number(q.limit) : undefined,
    startingAfter: q.starting_after || q.offset || undefined,
    search: q.q?.trim() || undefined,
    sortField,
    sortDesc,
    filters,
    includeDeleted: q.include_deleted === "true",
  };
}

/**
 * The paginated list envelope: `{ object, data, has_more, next_cursor, total, total_capped }`, plus
 * `next_offset` (the same token as `next_cursor`) while `has_more`. Every caller must
 * accept `offset` as an alias of `starting_after`, or `next_offset` would be a lie.
 */
export function listResponse<T, U>(page: ListPage<T>, serialize: (row: T) => U) {
  return {
    object: "list" as const,
    data: page.data.map(serialize),
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
    total: page.total,
    // `total` stopped counting at 10,000; show it as "10,000+".
    total_capped: page.totalCapped ?? false,
    ...(page.hasMore && page.nextCursor ? { next_offset: page.nextCursor } : {}),
  };
}

/**
 * CP-0 optimistic concurrency. Thrown by a service update when the caller passed
 * an `expected_version` that no longer matches the row's `resource_version`.
 * Routes catch it and reply 409.
 */
export class VersionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`resource_version mismatch: expected ${expected}, found ${actual}`);
    this.name = "VersionConflictError";
  }
}

/** Tags a preHandler with the permission it checks. The boot gate reads it (permission-registry). */
export const PERMISSION_TAG = Symbol.for("tmb.permission");
/** Tags a route that is open to every caller of `authenticate`, with the reason. */
export const EXEMPT_TAG = Symbol.for("tmb.permission.exempt");
/** Set on `requireMemberPermission`: a session-only route that resolves the member itself. */
export const MEMBER_TAG = Symbol.for("tmb.permission.member");

type Tagged = Record<symbol, string | boolean>;

/** The 403 for a caller that lacks `key`. Members and keys get different codes. */
export function missingPermission(reply: FastifyReply, def: PermissionDef, member: boolean) {
  return reply.code(403).send({
    error: member
      ? {
          type: "permission_error",
          code: "missing_permission",
          required: def.key,
          message: `We could not do this. Your role does not have the ${def.key} permission. Ask an owner or admin to give it to you.`,
        }
      : {
          type: "permission_error",
          code: "key_missing_permission",
          required: def.key,
          message: def.operatorOnly
            ? "We could not do this with an API key. Only a signed-in team member can do it."
            : `We could not do this. This API key does not have ${def.mode} access to ${def.resource}. Use a key that has it.`,
        },
  });
}

/**
 * Require one catalogue permission. Runs after `authenticate`.
 *
 * A member holds the keys of their role (fixed or custom). An API key holds keys by its
 * permission map, or by its scope when it has none (every key minted before maps existed).
 */
export function requirePerm(key: PermissionKey) {
  const def = permissionDef(key)!;
  const fn = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.hasOperator) {
      if (req.operatorPermissions?.has(key)) return;
      return missingPermission(reply, def, true);
    }
    if (apiKeyHolds(def, req.apiKeyScope ?? null, req.apiKeyPermissions ?? null)) return;
    return missingPermission(reply, def, false);
  };
  (fn as unknown as Tagged)[PERMISSION_TAG] = key;
  return fn;
}

/** True when the caller holds `key` (a field gated inside a route `requirePerm` already let in). */
export function callerHolds(req: FastifyRequest, key: PermissionKey): boolean {
  const def = permissionDef(key)!;
  if (req.hasOperator) return req.operatorPermissions?.has(key) ?? false;
  return apiKeyHolds(def, req.apiKeyScope ?? null, req.apiKeyPermissions ?? null);
}

/** Declare an `authenticate` route open to every caller, and why. Checks nothing. */
export function noMemberPermission(reason: string) {
  const fn = async () => {};
  (fn as unknown as Tagged)[EXEMPT_TAG] = reason;
  return fn;
}
