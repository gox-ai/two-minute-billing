/**
 * The TM Test Gateway's `form_post` challenge (`buyer_auth_mode=form_post`), standing in
 * for gateways that take the buyer as a signed form POST and send them back the same way.
 *
 * The adapter puts `{ action, fields }` in `next_action.formPost`; the storefront submits
 * it; `/v1/tmtest/form_post` (api/tmtest-routes.ts) checks the signature, resolves the
 * challenge and POSTs the buyer back to `return_url`. The engine never reads what is
 * posted back: completion asks the gateway (`fetchIntent`).
 */
import { createHash } from "node:crypto";
import { config } from "@/platform/config";
import { signTmtest, verifyTmtest } from "./signing";

export const TMTEST_FORM_POST_PATH = "/v1/tmtest/form_post";

/** This API's public origin; the form is posted there by the buyer's browser. */
export function formPostAction(): string {
  const base = (config.WEBHOOK_BASE_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, "");
  return `${base}${TMTEST_FORM_POST_PATH}`;
}

function signedPart(intent: string, returnUrl?: string): Record<string, string> {
  return { intent, ...(returnUrl ? { return_url: returnUrl } : {}) };
}

/** The fields a challenge carries. Signed, so the route only acts on fields we issued. */
export function formPostFields(intentId: string, returnUrl?: string): Record<string, string> {
  const fields = signedPart(intentId, returnUrl);
  return { ...fields, signature: signTmtest(fields) };
}

/** True when `intent` and `return_url` are the ones `formPostFields` signed. */
export function verifyFormPostFields(fields: Record<string, string>): boolean {
  if (typeof fields.intent !== "string" || typeof fields.signature !== "string") return false;
  return verifyTmtest(signedPart(fields.intent, fields.return_url), fields.signature);
}

/** Submits the page's only form. Admitted by hash in the route's CSP. */
export const AUTO_SUBMIT_SCRIPT = "document.forms[0].submit()";
export const AUTO_SUBMIT_SCRIPT_SHA256 = `sha256-${createHash("sha256")
  .update(AUTO_SUBMIT_SCRIPT, "utf8")
  .digest("base64")}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page that POSTs the buyer back to `returnUrl`, as a signed-field gateway does. */
export function autoSubmitPage(returnUrl: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>TM Test Gateway</title></head>` +
    `<body><form method="post" action="${esc(returnUrl)}">${inputs}` +
    `<noscript><button type="submit">Continue</button></noscript></form>` +
    `<script>${AUTO_SUBMIT_SCRIPT}</script></body></html>`
  );
}
