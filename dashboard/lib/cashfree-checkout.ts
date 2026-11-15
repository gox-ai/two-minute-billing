/**
 * Cashfree's browser SDK, for `mode: 'sdk'` authorizations (`sdk.provider === 'cashfree'`).
 *
 * `params` comes from `src/providers/cashfree.ts`:
 *   - `kind: 'subscription'` — a mandate. `subscriptionsCheckout` leaves the page, and
 *     Cashfree POSTs the buyer back to the return URL (`/gateway-return` bounce). The
 *     caller stashed the setup first, so the return leg finishes it.
 *   - `kind: 'order'` — a one-time payment, in Cashfree's modal over our page.
 * Card and bank details stay inside Cashfree's pages (PCI SAQ-A).
 */
import { cashfreeFailure, contactBusiness } from "./gateway-errors";
import type { GatewaySdkContext, GatewaySdkResult } from "./gateway-sdk";

interface CashfreeResult {
  error?: { message?: string; code?: string };
  redirect?: boolean;
  paymentDetails?: unknown;
}
interface CashfreeInstance {
  checkout(opts: Record<string, unknown>): Promise<CashfreeResult>;
  subscriptionsCheckout(opts: Record<string, unknown>): Promise<CashfreeResult>;
}
declare global {
  interface Window {
    Cashfree?: (opts: { mode: "sandbox" | "production" }) => CashfreeInstance;
  }
}

const SCRIPT_SRC = "https://sdk.cashfree.com/js/v3/cashfree.js";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Cashfree) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("We could not load the payment form. Reload the page. Then try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/** A promise that never settles: the page is leaving for Cashfree. */
const leaving = () => new Promise<GatewaySdkResult>(() => {});

export async function openCashfreeCheckout(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  if (!sessionId)
    return {
      status: "failed",
      message: `We could not open the payment form. ${contactBusiness(context.businessName)}`,
    };
  await loadScript();
  const cashfree = window.Cashfree!({
    mode: params.environment === "production" ? "production" : "sandbox",
  });

  if (params.kind === "subscription") {
    const res = await cashfree.subscriptionsCheckout({
      subsSessionId: sessionId,
      redirectTarget: "_self",
    });
    if (res?.error)
      return {
        status: "failed",
        message: cashfreeFailure("subscription", res.error, context.businessName),
      };
    return leaving();
  }

  const res = await cashfree.checkout({ paymentSessionId: sessionId, redirectTarget: "_modal" });
  if (res?.redirect) return leaving();
  // A close and a failed payment both come back as `error`, with nothing to tell them
  // apart: shown either way, so a decline is never taken for a close.
  if (res?.error) return { status: "failed", message: cashfreeFailure("order", res.error) };
  return { status: "completed" };
}
