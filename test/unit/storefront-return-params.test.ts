import { describe, it, expect } from "vitest";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points at
// src/ (same reasoning as `currency-exponent.test.ts`).
//
// `return-params` and NOT the two `pending-*` modules that wrap it, deliberately: those
// touch `sessionStorage` and `window`, and the root tsconfig is `lib: ["ES2023"]` with no
// DOM — importing them here turned the whole root typecheck red. Splitting the pure RULE
// out from the DOM strip is what makes it testable from this suite at all.
import {
  readPaymentReturn,
  readSdkReturnResult,
  readSetupReturn,
} from "../../dashboard/lib/return-params";

/**
 * The portal mounts BOTH return components — `SetupReturn` (add-a-card) and
 * `PaymentReturn` (Pay now) — on one page, and a provider brings the buyer back to one
 * `/portal` URL for either. So which one claims the return is decided entirely by these
 * two readers, and the failure they can produce is silent: the wrong leg claims it,
 * strips the params, and the right one never runs.
 *
 * The trap is that `readSetupReturn` deliberately fires on a BARE `razorpay_payment_id` /
 * `approval_token_id` with no `?setup=` — that echo is the only signal a vault return has
 * when RazorPay redirects the main window for 3DS. A redirect-mode PAYMENT return carries
 * the identical echo.
 */
describe("portal return-param readers", () => {
  it("payment return is claimed by the payment reader", () => {
    expect(readPaymentReturn("?pay=return")).toBe("return");
  });

  it("payment cancel is distinguished from return", () => {
    expect(readPaymentReturn("?pay=cancel")).toBe("cancel");
  });

  it("the setup reader stands down on a payment return", () => {
    expect(readSetupReturn("?pay=return")).toBeNull();
  });

  /**
   * The regression that motivated the guard, and the ONLY case that catches it: RazorPay
   * echoes `razorpay_payment_id` on a main-window 3DS redirect for a PAYMENT exactly as it
   * does for a vault, so this shape is reachable in production. Without the `?pay=` guard
   * the setup reader claims it — a bare `?pay=return` does not, because the original
   * condition already required a `setup` param or an echo.
   */
  it("the setup reader stands down even when the provider echoes a payment id", () => {
    expect(readSetupReturn("?pay=return&razorpay_payment_id=pay_ABC123")).toBeNull();
    expect(readPaymentReturn("?pay=return&razorpay_payment_id=pay_ABC123")).toBe("return");
  });

  it("a genuine vault return is still claimed by the setup reader", () => {
    const ret = readSetupReturn("?setup=return&approval_token_id=tok_XYZ");
    expect(ret?.outcome).toBe("return");
    expect(ret?.approvalToken).toBe("tok_XYZ");
  });

  it("a bare provider echo with no `pay` still reaches the setup reader", () => {
    expect(readSetupReturn("?razorpay_payment_id=pay_ABC123")?.approvalToken).toBe("pay_ABC123");
  });

  it("a vault CANCEL is distinguished from a return", () => {
    expect(readSetupReturn("?setup=cancel")?.outcome).toBe("cancel");
  });

  it("the payment reader ignores a vault return", () => {
    expect(readPaymentReturn("?setup=return&approval_token_id=tok_XYZ")).toBeNull();
  });

  it("neither reader fires on a clean portal load", () => {
    expect(readPaymentReturn("")).toBeNull();
    expect(readSetupReturn("")).toBeNull();
  });
});

/** Checkout.com Flow leaves for its 3DS step and comes back naming the payment. */
describe("sdk gateway return result", () => {
  const back =
    "?setup=return&cko-payment-session-id=ps_X&cko-session-id=sid_X&cko-payment-id=pay_XXXXXXXXXXXX01";

  it("the setup reader carries the payment id as the client result", () => {
    expect(readSetupReturn(back)?.clientResult).toEqual({ "cko-payment-id": "pay_XXXXXXXXXXXX01" });
  });

  it("a payment return carries it too", () => {
    expect(readSdkReturnResult(back.replace("setup", "pay"))).toEqual({
      "cko-payment-id": "pay_XXXXXXXXXXXX01",
    });
  });

  it("no echo, no client result", () => {
    expect(readSetupReturn("?setup=return")?.clientResult).toBeNull();
    expect(readSdkReturnResult("?pay=return")).toBeNull();
  });
});
