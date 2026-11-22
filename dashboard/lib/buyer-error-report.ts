/**
 * Report every payment error a buyer reads on the storefront to the engine, so a gateway's
 * own text that reaches the screen is caught by ops, not by eye.
 *
 * Fire-and-forget: a failed report never changes what the buyer sees. The engine decides
 * whether the text is a leak (`src/modules/ops/buyer-error-leak.ts`).
 *
 * The gateway helpers (`gateway-errors.ts`) note the raw signal behind each text they build;
 * the place that shows the text (`RefusalAlert`, a toast) reports it, and the note is found
 * again by the text. No card number and no payer detail is sent: codes, a capped and
 * redacted copy of the gateway's message, and the text shown.
 *
 * With the intent the page is confirming (`setActiveIntent`), the engine also books a
 * gateway refusal on that intent's open attempt, for the operator (`book-browser-failure.ts`).
 */

/** The raw gateway signal behind a shown error. */
export interface GatewaySignal {
  gateway?: string | null;
  type?: string | null;
  code?: string | null;
  declineCode?: string | null;
  /** The request field the gateway refused (Stripe `param`). */
  param?: string | null;
  /** The gateway's own words, for ops only. Capped and redacted before it is sent. */
  message?: string | null;
  /** The text keeps a field instruction from the gateway's form on purpose. */
  fieldError?: boolean;
}

export type BuyerSurface = "checkout" | "portal";

/** The body of `POST /<surface>/client-error`, and of the engine route behind it. */
export interface BuyerErrorReport {
  text: string;
  step: string | null;
  page: string | null;
  gateway: string | null;
  type: string | null;
  code: string | null;
  decline_code: string | null;
  param: string | null;
  gateway_message: string | null;
  field_error: boolean;
  /** Our intent (`pi_…`) the page is confirming, when there is one. */
  payment_intent: string | null;
}

export const REPORT_TEXT_MAX = 1000;
export const REPORT_MESSAGE_MAX = 300;
const NOTE_TTL_MS = 120_000;
const NOTE_MAX = 10;
const RESEND_AFTER_MS = 5_000;

const notes: Array<{ text: string; signal: GatewaySignal; at: number }> = [];
let activeGateway: string | null = null;
let activeIntent: string | null = null;

/** Keep the signal behind `text` for the report that shows it. Returns `text`. */
export function noteGatewaySignal(text: string, signal: GatewaySignal): string {
  notes.unshift({ text, signal, at: Date.now() });
  notes.length = Math.min(notes.length, NOTE_MAX);
  return text;
}

/** The newest signal noted for a text that the shown text contains. */
export function signalFor(shown: string, now = Date.now()): GatewaySignal | null {
  const hit = notes.find((n) => now - n.at <= NOTE_TTL_MS && shown.includes(n.text));
  return hit?.signal ?? null;
}

/** The gateway whose form is open, for an error that carries no signal of its own. */
export function setActiveGateway(key: string | null): void {
  activeGateway = key;
}

/** Our intent (`pi_…`) the page is confirming now, or null when the flow has none. */
export function setActiveIntent(publicId: string | null | undefined): void {
  activeIntent = publicId && /^pi_[A-Za-z0-9]+$/.test(publicId) ? publicId : null;
}

/**
 * The flow is over (success, the buyer closed it, or it moved on): a later refusal must not
 * name this intent. With `expected`, only that intent is cleared.
 */
export function clearActiveIntent(expected?: string | null): void {
  if (expected == null || activeIntent === expected) activeIntent = null;
}

/** The intent a report would name now. */
export function activeIntentNow(): string | null {
  return activeIntent;
}

/** A card or account number, an email address: never sent. */
export function redact(s: string): string {
  return s
    .replace(/(?:\d[ -]?){5,}\d/g, "[number]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]");
}

const cap = (s: string | null | undefined, max: number): string | null => {
  const t = s?.trim();
  return t ? redact(t).slice(0, max) : null;
};

/** The surface a storefront path belongs to, or null off the storefront. */
export function surfaceOf(pathname: string): BuyerSurface | null {
  if (pathname === "/checkout" || pathname.startsWith("/checkout/")) return "checkout";
  if (pathname === "/portal" || pathname.startsWith("/portal/")) return "portal";
  return null;
}

/** Pure: the report for a shown text, or null when there is nothing to report. */
export function buildBuyerErrorReport(
  shown: string | null | undefined,
  opts: { step?: string | null; gateway?: string | null; page?: string | null; now?: number } = {},
): BuyerErrorReport | null {
  const text = cap(shown, REPORT_TEXT_MAX);
  if (!text) return null;
  const s = signalFor(shown!.trim(), opts.now) ?? {};
  const str = (v: string | null | undefined, max = 80) => cap(v, max);
  return {
    text,
    step: str(opts.step, 64),
    page: str(opts.page, 200),
    gateway: str(opts.gateway ?? s.gateway ?? activeGateway, 40),
    type: str(s.type),
    code: str(s.code),
    decline_code: str(s.declineCode),
    param: str(s.param, 40),
    gateway_message: str(s.message, REPORT_MESSAGE_MAX),
    field_error: s.fieldError === true,
    payment_intent: activeIntent,
  };
}

const sent = new Map<string, number>();

/** Send the report. Never throws, never waits, never changes the page. */
export function reportBuyerError(
  shown: string | null | undefined,
  opts: { step?: string | null; gateway?: string | null } = {},
): void {
  try {
    if (typeof window === "undefined" || !shown) return;
    const surface = surfaceOf(window.location.pathname);
    if (!surface) return;
    const report = buildBuyerErrorReport(shown, { ...opts, page: window.location.pathname });
    if (!report) return;
    // One error re-rendered (or shown twice) is one report.
    const now = Date.now();
    if (now - (sent.get(report.text) ?? 0) < RESEND_AFTER_MS) return;
    sent.set(report.text, now);
    const url = `/${surface}/client-error`;
    const body = JSON.stringify(report);
    const queued =
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    if (!queued)
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => undefined);
  } catch {
    // Telemetry: never the buyer's problem.
  }
}
