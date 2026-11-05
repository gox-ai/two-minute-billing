/**
 * Authorize.net's hosted payment form (AcceptUI.js), for `mode: 'sdk'` authorizations
 * (`sdk.provider === 'authorizenet'`). The card is entered in Authorize.net's own iframe
 * (PCI SAQ A); we get a single-use nonce back and post it as `client_result`.
 *
 * `params` comes from `src/providers/authorizenet.ts`: `apiLoginId`, `clientKey` (the Public
 * Client Key), `environment` and `method` (`card`, or `us_bank_account` for an eCheck: the
 * form then shows the bank account fields only). The script URL is chosen HERE from `environment`, never
 * taken from the server.
 *
 * AcceptUI binds to the first `.AcceptUI` element when it loads and reads its data
 * attributes once, so each open removes the old copy and loads the script again. A close
 * of the form arrives as a `CLOSE_IFRAME` message from the form's origin.
 */
import type { GatewaySdkContext, GatewaySdkResult } from "./gateway-sdk";

const SCRIPT = {
  sandbox: {
    src: "https://jstest.authorize.net/v3/AcceptUI.js",
    origin: "https://jstest.authorize.net",
  },
  production: {
    src: "https://js.authorize.net/v3/AcceptUI.js",
    origin: "https://js.authorize.net",
  },
} as const;

interface AcceptResponse {
  opaqueData?: { dataDescriptor?: string; dataValue?: string };
  messages?: { resultCode?: string; message?: Array<{ code?: string; text?: string }> };
  customerInformation?: { firstName?: string; lastName?: string };
}

let opened = 0;

/** Remove what an earlier open left behind, so the next load binds to the new button. */
function reset() {
  for (const el of document.querySelectorAll(
    "script[data-tmb-accept], button[data-tmb-accept], #AcceptUIContainer, #AcceptUIBackground",
  ))
    el.remove();
}

export function openAuthorizenetAccept(
  params: Record<string, unknown>,
  context: GatewaySdkContext,
): Promise<GatewaySdkResult> {
  const apiLoginId = typeof params.apiLoginId === "string" ? params.apiLoginId : "";
  const clientKey = typeof params.clientKey === "string" ? params.clientKey : "";
  const env = params.environment === "production" ? SCRIPT.production : SCRIPT.sandbox;
  const bank = params.method === "us_bank_account";
  if (!apiLoginId || !clientKey)
    return Promise.resolve({
      status: "failed",
      message: "We could not open the card form. Contact the business.",
    });

  return new Promise((resolve) => {
    let settled = false;
    const handlerName = `__tmbAcceptResponse${++opened}`;
    const w = window as unknown as Record<string, unknown>;
    const finish = (result: GatewaySdkResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      // Kept as a no-op: an earlier copy of the script may still call it.
      w[handlerName] = () => undefined;
      resolve(result);
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { verifyOrigin?: string; type?: string } | null;
      if (e.origin !== env.origin || !data || data.verifyOrigin !== "AcceptMain") return;
      // The response itself goes to the handler; a close without one is a dismissal.
      if (data.type === "CLOSE_IFRAME") setTimeout(() => finish({ status: "dismissed" }), 0);
    };
    w[handlerName] = (res: AcceptResponse) => {
      const value = res?.opaqueData?.dataValue;
      if (res?.messages?.resultCode !== "Ok" || !value) {
        finish({
          status: "failed",
          message: bank
            ? "We could not read the bank account details. Try again. If the problem continues, contact the business."
            : "We could not read the card details. Try again. If the problem continues, contact the business.",
        });
        return;
      }
      finish({
        status: "completed",
        clientResult: {
          dataDescriptor: res.opaqueData?.dataDescriptor ?? "",
          dataValue: value,
          ...(res.customerInformation?.firstName
            ? { firstName: res.customerInformation.firstName }
            : {}),
          ...(res.customerInformation?.lastName
            ? { lastName: res.customerInformation.lastName }
            : {}),
        },
      });
    };
    window.addEventListener("message", onMessage);

    reset();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "AcceptUI";
    button.hidden = true;
    button.setAttribute("data-tmb-accept", "");
    button.setAttribute("data-apiLoginID", apiLoginId);
    button.setAttribute("data-clientKey", clientKey);
    button.setAttribute(
      "data-acceptUIFormHeaderTxt",
      context.businessName || (bank ? "Bank account details" : "Card details"),
    );
    button.setAttribute(
      "data-acceptUIFormBtnTxt",
      context.purpose === "setup"
        ? bank
          ? "Save bank account"
          : "Save card"
        : typeof params.amount === "string" && typeof params.currency === "string"
          ? `Pay ${params.amount} ${params.currency}`
          : "Pay",
    );
    button.setAttribute(
      "data-paymentOptions",
      JSON.stringify({ showCreditCard: !bank, showBankAccount: bank }),
    );
    // Name and ZIP code; the ZIP code rides inside the nonce.
    button.setAttribute(
      "data-billingAddressOptions",
      JSON.stringify({ show: true, required: false }),
    );
    button.setAttribute("data-responseHandler", handlerName);
    document.body.appendChild(button);

    const script = document.createElement("script");
    script.src = env.src;
    script.async = true;
    script.setAttribute("data-tmb-accept", "");
    script.onload = () => {
      // AcceptUI binds when the document is complete; it is by now, so the click opens it.
      setTimeout(() => button.click(), 0);
    };
    script.onerror = () =>
      finish({
        status: "failed",
        message: "We could not connect to Authorize.net. Check your connection. Then try again.",
      });
    document.body.appendChild(script);
  });
}
