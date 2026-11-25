"use server";

import { requestNewLink } from "@/lib/new-link-api";
import { readStorefrontToken } from "@/lib/storefront-session";

export type NewLinkResult = { ok: boolean; message: string };

const TEXT = {
  accepted:
    "We sent a new link to your email address. If you do not get it in a few minutes, look in your spam folder.",
  limited: "You asked for a new link too many times. Wait 15 minutes and try again.",
  failed: "We could not send a new link. Try again in a few minutes.",
} as const;

/** The portal's expired link: its token is in the page URL, so the page passes it. */
export async function emailNewPortalLinkAction(token: string): Promise<NewLinkResult> {
  const r = await requestNewLink("portal", token);
  return { ok: r === "accepted", message: TEXT[r] };
}

/** The checkout's expired link: its token is in the checkout cookie. */
export async function emailNewCheckoutLinkAction(): Promise<NewLinkResult> {
  const token = await readStorefrontToken("checkout");
  if (!token) return { ok: false, message: TEXT.failed };
  const r = await requestNewLink("checkout", token);
  return { ok: r === "accepted", message: TEXT[r] };
}
