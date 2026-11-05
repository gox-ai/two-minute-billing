"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { trackSignUp } from "@/lib/analytics";
import { z } from "zod";
import { actionError, parseForm, type ActionResult } from "@/lib/action-result";
import { LIMITS } from "@/lib/limits";
import { forwardedFor } from "@/lib/forwarded-for";
import {
  GOOGLE_SIGNUP_COOKIE,
  SESSION_COOKIE,
  SIGNUP_CONFIRM_COOKIE,
  SIGNUP_INVITE_COOKIE,
  expire,
  sessionCookieOptions,
  signupCookieOptions,
} from "@/lib/auth-cookies";
import { LANDING_PATH } from "@/lib/redirect-to";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

const profile = {
  name: z.string().trim().min(1, "Enter your name").max(200),
  organization_name: z.string().trim().min(1, "Enter your company name").max(200),
  country: z.string().regex(/^[A-Z]{2}$/, "Select your country"),
  billing_volume: z.enum(["none", "under_10k", "10k_100k", "100k_500k", "over_500k"], {
    message: "Select how much you bill each month",
  }),
  gateway: z.enum(["stripe", "razorpay", "paypal", "other", "none"], {
    message: "Select your payment gateway",
  }),
  turnstile_token: z.string().max(4096).optional(),
};
const passwordSchema = z.object({
  ...profile,
  email: z
    .string()
    .trim()
    .min(1, "Enter your work email")
    .email("Enter a valid email address")
    .max(LIMITS.email),
  password: z
    .string()
    .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters`)
    .max(LIMITS.password),
});
const googleSchema = z.object(profile);
const inviteSchema = z.object({
  ...profile,
  password: passwordSchema.shape.password,
});
const requestSchema = z.object({
  name: profile.name,
  email: passwordSchema.shape.email,
  company: z.string().trim().min(1, "Enter your company name").max(200),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  billing_volume: profile.billing_volume.optional().or(z.literal("").transform(() => undefined)),
  gateway: profile.gateway.optional().or(z.literal("").transform(() => undefined)),
  message: z.string().trim().max(2000).optional(),
  turnstile_token: profile.turnstile_token,
});

/** An access request while sign-up is locked (0405). */
export async function signupRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseForm(requestSchema, formData);
  if (parsed.error) return parsed.error;
  const res = await fetch(`${BASE}/auth/signup_requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return actionError(json.error?.message ?? "We could not send your request. Try again.");
  }
  redirect("/signup?requested=1");
}

/** Spend a staff-sent sign-up link: create the account and sign in (0405). */
export async function signupInviteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(SIGNUP_INVITE_COOKIE)?.value;
  if (!token)
    return actionError("This link is not valid or is expired. Open the link in the email again.");
  const parsed = parseForm(inviteSchema, formData);
  if (parsed.error) return parsed.error;
  const ip = (await headers()).get("cf-ipcountry")?.toUpperCase();
  const ipCountry = ip && /^[A-Z]{2}$/.test(ip) && ip !== "XX" ? { ip_country: ip } : {};
  const res = await fetch(`${BASE}/auth/signup/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ ...parsed.data, ...ipCountry, token }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.token)
    return actionError(json.error?.message ?? "We could not create your account. Try again.");
  jar.set(SIGNUP_INVITE_COOKIE, "", expire(signupCookieOptions()));
  jar.set(SESSION_COOKIE, json.token, sessionCookieOptions());
  after(() => trackSignUp("email"));
  redirect(LANDING_PATH);
}

/** Password sign-up: always "check your email"; Google sign-up: signed in at once. */
export async function signupAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const ticket = jar.get(GOOGLE_SIGNUP_COOKIE)?.value;
  const parsed = ticket ? parseForm(googleSchema, formData) : parseForm(passwordSchema, formData);
  if (parsed.error) return parsed.error;

  // Billing prices by where the request came from, not by the country typed in the form.
  const ip = (await headers()).get("cf-ipcountry")?.toUpperCase();
  const ipCountry = ip && /^[A-Z]{2}$/.test(ip) && ip !== "XX" ? { ip_country: ip } : {};
  const res = await fetch(`${BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify(
      ticket
        ? { ...parsed.data, ...ipCountry, google_ticket: ticket }
        : { ...parsed.data, ...ipCountry },
    ),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: { message?: string };
  };
  if (!res.ok)
    return actionError(json.error?.message ?? "We could not create your account. Try again.");
  if (ticket) {
    if (!json.token) return actionError("We could not create your account. Try again.");
    jar.set(GOOGLE_SIGNUP_COOKIE, "", expire(signupCookieOptions()));
    jar.set(SESSION_COOKIE, json.token, sessionCookieOptions());
    after(() => trackSignUp("google"));
    redirect(LANDING_PATH);
  }
  redirect("/signup?sent=1");
}

/** Spend the emailed link, held in a cookie by `/signup/confirm/s/<token>`. */
export async function confirmSignupAction(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(SIGNUP_CONFIRM_COOKIE)?.value;
  if (!token) redirect("/signup?expired=1");
  const res = await fetch(`${BASE}/auth/signup/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: { message?: string };
  };
  jar.set(SIGNUP_CONFIRM_COOKIE, "", expire(signupCookieOptions()));
  if (!res.ok || !json.token)
    return actionError(
      json.error?.message ?? "This link is not valid or is expired. Sign up again.",
    );
  jar.set(SESSION_COOKIE, json.token, sessionCookieOptions());
  after(() => trackSignUp("email"));
  redirect(LANDING_PATH);
}

/** Drop a pending Google identity and return to the email form. */
export async function cancelGoogleSignupAction(): Promise<void> {
  (await cookies()).set(GOOGLE_SIGNUP_COOKIE, "", expire(signupCookieOptions()));
  redirect("/signup");
}
