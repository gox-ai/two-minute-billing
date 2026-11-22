import type { FastifyReply, FastifyRequest } from "fastify";
import { createLogger } from "@/platform/logger";
import { buyerRejectionRecorded, recordBuyerRejection } from "@/modules/ops/buyer-rejections";
import {
  BUYER_GENERIC_FIELD_REASON,
  BUYER_GENERIC_REFUSAL,
  CODE_MATCHED,
} from "@/providers/payer-wording";

const log = createLogger("api.buyer-error-text");

export { BUYER_GENERIC_REFUSAL, BUYER_GENERIC_FIELD_REASON } from "@/providers/payer-wording";

/** Markers of operator text: an API parameter, a public id, code formatting, an API reply. */
const OPERATOR_MARKERS: readonly RegExp[] = [
  /`/,
  /\bUnknown parameter\b/,
  // snake_case: an API field name (`state_code`, `replace_items_list`).
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/,
  // A public id: a lower-case prefix and a random tail (`pi_XXXXXXXXXXXX01`).
  /\b[a-z]{2,10}_[A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*\b/,
];

/** True when a refusal reads as written for an operator. Quoted text is the payer's own input. */
export function isOperatorText(message: string): boolean {
  if (CODE_MATCHED.some((re) => re.test(message))) return false;
  const unquoted = message.replace(/"[^"]*"/g, '""');
  return OPERATOR_MARKERS.some((re) => re.test(unquoted));
}

interface ErrorEnvelope {
  error?: {
    message?: unknown;
    details?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * The envelope a payer may read: an operator message becomes `BUYER_GENERIC_REFUSAL`, an
 * operator field reason `BUYER_GENERIC_FIELD_REASON`. `type`, `code` and `param` stay, so a
 * client that branches on them still works. Returns null when nothing changes.
 */
export function payerSafeEnvelope(body: ErrorEnvelope): ErrorEnvelope | null {
  const err = body.error;
  if (!err || typeof err !== "object") return null;
  let changed = false;
  const next = { ...err };
  if (typeof err.message === "string" && isOperatorText(err.message)) {
    next.message = BUYER_GENERIC_REFUSAL;
    changed = true;
  }
  if (err.details && typeof err.details === "object") {
    const details: Record<string, unknown> = {};
    for (const [field, reasons] of Object.entries(err.details)) {
      details[field] = Array.isArray(reasons)
        ? reasons.map((r) => {
            if (typeof r === "string" && isOperatorText(r)) {
              changed = true;
              return BUYER_GENERIC_FIELD_REASON;
            }
            return r;
          })
        : reasons;
    }
    next.details = details;
  }
  return changed ? { ...body, error: next } : null;
}

/**
 * `preSerialization` hook: a 4xx answer to a buyer session (portal or hosted checkout) never
 * carries operator text. The original goes to the log and to `buyer_request_rejections`.
 */
export function buyerErrorTextHook(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (err: Error | null, payload?: unknown) => void,
): void {
  const status = reply.statusCode;
  if (
    status < 400 ||
    status >= 500 ||
    (!req.portalSession && !req.checkoutSession) ||
    !payload ||
    typeof payload !== "object"
  )
    return done(null, payload);
  const safe = payerSafeEnvelope(payload as ErrorEnvelope);
  if (!safe) return done(null, payload);
  const original = (payload as ErrorEnvelope).error ?? {};
  // Redacted as `badRequest` does: a quoted value is the payer's input, kept out of storage.
  const message = (typeof original.message === "string" ? original.message : "").replace(
    /"[^"]*"/g,
    '"…"',
  );
  log.warn("operator text withheld from a buyer", {
    event: "buyer_operator_text_withheld",
    route: req.routeOptions?.url ?? req.url,
    status,
    message,
  });
  if (!buyerRejectionRecorded(req)) recordBuyerRejection(req, message, {});
  done(null, safe);
}
