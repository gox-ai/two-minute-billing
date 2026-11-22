"use server";

import { cookies } from "next/headers";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { forwardedFor } from "@/lib/forwarded-for";
import {
  DESTINATION_CONFIRM_COOKIE,
  DESTINATION_DONE_COOKIE,
  destinationCookieOptions,
  expire,
} from "@/lib/auth-cookies";
import { DESTINATION_CONFIRM_PATH } from "@/lib/api/notifications";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";
const INVALID = "This link is not valid or is expired.";

/** Spend the emailed token (0533). The answer names no organization and no address. */
export async function confirmDestinationAction(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(DESTINATION_CONFIRM_COOKIE)?.value;
  if (!token) return actionError(INVALID);
  const res = await fetch(`${BASE}${DESTINATION_CONFIRM_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  jar.set(DESTINATION_CONFIRM_COOKIE, "", expire(destinationCookieOptions()));
  if (!res.ok) {
    if (res.status === 429)
      return actionError("We could not confirm the address. Too many tries. Try again later.");
    return actionError(INVALID);
  }
  jar.set(DESTINATION_DONE_COOKIE, "1", destinationCookieOptions());
  return actionOk("Email address confirmed.");
}
