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
      reject(new Error("We could not connect to Cashfree. Check your connection. Then try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/** A promise that never settles: the page is leaving for Cashfree. */
const leaving = () => new Promise<GatewaySdkResult>(() => {});

export async function openCashfreeCheckout(
  params: Record<string, unknown>,
  _context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  if (!sessionId)
    return {
      status: "failed",
      message: "We could not open the payment form. Contact the business.",
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
        message:
          "We could not open the mandate form. Try again. If the problem continues, contact the business.",
      };
    return leaving();
  }

  const res = await cashfree.checkout({ paymentSessionId: sessionId, redirectTarget: "_modal" });
  if (res?.redirect) return leaving();
  if (res?.error) {
    // Closing the modal reports an error too. The order stays payable, so it is a dismissal.
    return { status: "dismissed" };
  }
  return { status: "completed" };
}
