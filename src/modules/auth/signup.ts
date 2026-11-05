/**
 * Self-serve sign-up (0354).
 *
 * Password: `beginPasswordSignup` answers the same for every address and only emails. The
 * pending sign-up is an `auth_tokens` row with no user; `completePasswordSignup` spends it and
 * creates the organization, the owner and a session together. So no unverified account exists,
 * and nobody can hold an address they do not control.
 *
 * Google: Google has verified the address, so the account is created at once. The identity is
 * carried from the OAuth callback to the sign-up form in a short-lived signed ticket.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { authTokens, memberships, users } from "@db/schema";
import { config } from "@/platform/config";
import { FREE_PLAN_MARK, signupOnFreePlan } from "@/platform/edition";
import { systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { createOrganization } from "@/modules/tenancy/service";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import {
  renderSignupConfirmEmail,
  renderSignupExistingAccountEmail,
  renderSignupInviteEmail,
} from "@/modules/emails/templates";
import { accountBrand } from "@/modules/emails/account-brand";
import { rejectPassword } from "./password-policy";
import {
  AuthError,
  hashPassword,
  sessionHash,
  startSessionFor,
  type AuthedUser,
  type LoginContext,
} from "./service";

const log = createLogger("auth.signup");

export const BILLING_VOLUMES = ["none", "under_10k", "10k_100k", "100k_500k", "over_500k"] as const;
export const SIGNUP_GATEWAYS = ["stripe", "razorpay", "paypal", "other", "none"] as const;

export interface SignupProfile {
  name: string;
  organizationName: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  billingVolume: (typeof BILLING_VOLUMES)[number];
  gateway: (typeof SIGNUP_GATEWAYS)[number];
  /** Where the sign-up request came from (IP); billing prices by it, not by the typed country. */
  ipCountry?: string;
}

const LINK_TTL_HOURS = 24;
const GOOGLE_TICKET_TTL_MS = 15 * 60_000;

/** Start a password sign-up. Never reveals whether the address has an account. */
export async function beginPasswordSignup(input: {
  email: string;
  password: string;
  profile: SignupProfile;
  ip?: string | null;
  dashboardBaseUrl?: string | null;
}): Promise<void> {
  const email = input.email.toLowerCase().trim();
  // Before the account lookup, so the answer cannot depend on whether the address is known.
  const rejected = await rejectPassword(input.password, email);
  if (rejected) throw new AuthError(rejected);

  const base = input.dashboardBaseUrl?.replace(/\/$/, "");
  if (!base) {
    log.warn("sign-up requested but DASHBOARD_BASE_URL is unset — no mail sent");
    return;
  }

  const [existing] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    const rendered = renderSignupExistingAccountEmail({
      name: existing.name,
      signInLink: `${base}/login`,
      resetLink: `${base}/forgot-password`,
    });
    await send(email, rendered, "signup_existing_account");
    return;
  }

  const token = `sgnp_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: null,
    purpose: "signup",
    tokenHash: sessionHash(token),
    expiresAt: new Date(Date.now() + LINK_TTL_HOURS * 3_600_000),
    requestedIp: input.ip ?? null,
    payload: JSON.stringify({
      email,
      passwordHash: hashPassword(input.password),
      profile: input.profile,
    }),
  });
  const rendered = renderSignupConfirmEmail({
    name: input.profile.name,
    link: `${base}/signup/confirm/s/${token}`,
    ttlHours: LINK_TTL_HOURS,
  });
  await send(email, rendered, "signup_confirm");
}

/** Spend a confirmation link: create the account and sign in. */
export async function completePasswordSignup(
  token: string,
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  const invalid = new AuthError("This link is not valid or is expired. Sign up again.");
  if (!token.startsWith("sgnp_")) throw invalid;
  // Single-use in the consuming UPDATE, as for password reset.
  const [claimed] = await systemDb
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, sessionHash(token)),
        eq(authTokens.purpose, "signup"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimed?.payload) throw invalid;
  const pending = JSON.parse(claimed.payload) as {
    email: string;
    passwordHash: string;
    profile: SignupProfile;
  };
  return provision(
    { email: pending.email, passwordHash: pending.passwordHash, googleSub: null, picture: null },
    pending.profile,
    ctx,
    "password",
  );
}

const INVITE_TTL_DAYS = 7;

/** What a sign-up link carries: the address it is for, and the answers to prefill. */
export interface SignupInvite {
  email: string;
  name: string;
  company: string;
  country: string | null;
  billingVolume: string | null;
  gateway: string | null;
}

/**
 * Email a one-time sign-up link to one address (0405). It works while self-serve sign-up is
 * locked, and only for that address: opening it proves the address, so the account is created
 * without a confirmation email.
 */
export async function sendSignupInvite(
  invite: SignupInvite,
  dashboardBaseUrl: string | null | undefined,
): Promise<void> {
  const base = dashboardBaseUrl?.replace(/\/$/, "");
  if (!base) throw new AuthError("DASHBOARD_BASE_URL is not set, so we cannot make the link.");
  const token = `sgni_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: null,
    purpose: "signup_invite",
    tokenHash: sessionHash(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    payload: JSON.stringify(invite),
  });
  const rendered = renderSignupInviteEmail({
    name: invite.name,
    link: `${base}/signup/invite/s/${token}`,
    ttlDays: INVITE_TTL_DAYS,
  });
  // Unlike `send`, a failure is raised: staff must know the person got nothing.
  await resolveMailer(null).send({
    to: invite.email,
    from: config.MAIL_FROM,
    fromName: accountBrand().name,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

const inviteWhere = (token: string) =>
  and(
    eq(authTokens.tokenHash, sessionHash(token)),
    eq(authTokens.purpose, "signup_invite"),
    isNull(authTokens.consumedAt),
    gt(authTokens.expiresAt, new Date()),
  );

/** The invite behind an unspent, unexpired link; null otherwise. */
export async function readSignupInvite(token: string): Promise<SignupInvite | null> {
  if (!token.startsWith("sgni_")) return null;
  const [row] = await systemDb
    .select({ payload: authTokens.payload })
    .from(authTokens)
    .where(inviteWhere(token))
    .limit(1);
  return row?.payload ? (JSON.parse(row.payload) as SignupInvite) : null;
}

/** Spend a sign-up link: create the account for the invited address and sign in. */
export async function completeInvitedSignup(
  token: string,
  password: string,
  profile: SignupProfile,
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  const invalid = new AuthError("This link is not valid or is expired. Ask us for a new link.");
  const invite = await readSignupInvite(token);
  if (!invite) throw invalid;
  const rejected = await rejectPassword(password, invite.email);
  if (rejected) throw new AuthError(rejected);
  // Checked before the link is spent, so a taken address does not burn it.
  const [existing] = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, invite.email))
    .limit(1);
  if (existing) throw new AuthError("An account already uses this email address. Sign in instead.");
  const [claimed] = await systemDb
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(inviteWhere(token))
    .returning({ id: authTokens.id });
  if (!claimed) throw invalid;
  return provision(
    {
      email: invite.email,
      passwordHash: hashPassword(password),
      googleSub: null,
      picture: null,
    },
    profile,
    ctx,
    "password",
  );
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/** A signed, short-lived carrier for a verified Google identity with no account yet. */
export function signGoogleSignupTicket(identity: GoogleIdentity): string {
  const body = Buffer.from(
    JSON.stringify({ ...identity, exp: Date.now() + GOOGLE_TICKET_TTL_MS }),
  ).toString("base64url");
  return `gsu_${body}.${ticketMac(body)}`;
}

/** The identity in a ticket, or null if it is forged or expired. */
export function readGoogleSignupTicket(ticket: string): GoogleIdentity | null {
  const m = /^gsu_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(ticket);
  if (!m) return null;
  const expected = Buffer.from(ticketMac(m[1]!));
  const given = Buffer.from(m[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const v = JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as GoogleIdentity & {
    exp: number;
  };
  if (v.exp < Date.now()) return null;
  return { sub: v.sub, email: v.email, name: v.name, picture: v.picture };
}

function ticketMac(body: string): string {
  // Domain-separated from API-key hashing, which uses the same secret.
  return createHmac("sha256", config.API_KEY_SECRET)
    .update(`google_signup:${body}`)
    .digest("base64url");
}

export async function completeGoogleSignup(
  ticket: string,
  profile: SignupProfile,
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  const identity = readGoogleSignupTicket(ticket);
  if (!identity) throw new AuthError("The Google sign-up expired. Sign up with Google again.");
  return provision(
    {
      email: identity.email.toLowerCase().trim(),
      passwordHash: null,
      googleSub: identity.sub,
      picture: identity.picture,
    },
    profile,
    ctx,
    "google",
  );
}

async function provision(
  who: {
    email: string;
    passwordHash: string | null;
    googleSub: string | null;
    picture: string | null;
  },
  profile: SignupProfile,
  ctx: LoginContext,
  authMethod: "password" | "google",
): Promise<{ token: string; user: AuthedUser }> {
  // The caller has proven the address, so saying it is taken reveals nothing new.
  const taken = new AuthError("An account already uses this email address. Sign in instead.");
  const [existing] = await systemDb
    .select({ id: users.id })
    .from(users)
    .where(
      who.googleSub
        ? or(eq(users.email, who.email), eq(users.googleSub, who.googleSub))
        : eq(users.email, who.email),
    )
    .limit(1);
  if (existing) throw taken;

  const org = await createOrganization({
    name: profile.organizationName,
    // Cloud sign-ups start on the Free plan, live mode on: account billing measures them.
    liveAccess: "enabled",
    liveAccessEnabledBy: signupOnFreePlan() ? FREE_PLAN_MARK : null,
    country: profile.country,
    signupAnswers: {
      billing_volume: profile.billingVolume,
      gateway: profile.gateway,
      ...(profile.ipCountry ? { ip_country: profile.ipCountry } : {}),
    },
  });
  let user: typeof users.$inferSelect;
  try {
    [user] = (await systemDb
      .insert(users)
      .values({
        publicId: publicId("usr"),
        email: who.email,
        name: profile.name,
        passwordHash: who.passwordHash,
        googleSub: who.googleSub,
        googlePictureUrl: who.picture,
        emailVerifiedAt: new Date(),
      })
      .returning()) as [typeof users.$inferSelect];
  } catch (e) {
    // Two confirmations for one address at once: the unique index decides.
    if ((e as { code?: string }).code === "23505") throw taken;
    throw e;
  }
  await systemDb
    .insert(memberships)
    .values({ organizationId: org.organization.id, userId: user.id, role: "owner" });
  log.log("organization created via self-serve sign-up", {
    organizationId: org.organization.publicId,
    user: user.publicId,
    authMethod,
    freePlan: signupOnFreePlan(),
  });
  return startSessionFor(user, ctx, { authMethod, mfaAt: null, stepUpAt: new Date() });
}

async function send(
  to: string,
  rendered: { subject: string; html: string; text: string },
  event: string,
): Promise<void> {
  // Deployment mailer, as for password reset: account mail belongs to no tenant. A failed send
  // is logged and swallowed, so the answer is the same either way.
  try {
    await resolveMailer(null).send({
      to,
      from: config.MAIL_FROM,
      fromName: accountBrand().name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch (err) {
    log.error(err, { event: `${event}_send_failed` });
  }
}
