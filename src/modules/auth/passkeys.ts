import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { userPasskeys, users, webauthnChallenges } from "@db/schema";
import { describeUserAgent } from "@/modules/emails/templates";
import { recordSecurityEvent, type SecurityContext } from "./security-events";

/**
 * Passkey ceremonies and storage (0330). The 2FA STATE a passkey changes — turning 2FA on with
 * the first method, the last-method rules — lives in `service.ts`, which imports this module and
 * never the other way round.
 */

const log = createLogger("auth.passkeys");

const CHALLENGE_TTL_MS = 5 * 60_000;
export const PASSKEY_NAME_MAX = 64;

export class PasskeyError extends Error {
  constructor(
    message: string,
    /** `not_found`: the credential is not on this account (any more) — the browser should forget it. */
    readonly reason:
      | "failed"
      | "expired"
      | "not_found"
      | "user_verification"
      | "duplicate" = "failed",
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

export interface PasskeyView {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The relying party: the DASHBOARD origin, where the browser runs the ceremony. */
export function passkeyRp(): { rpID: string; rpName: string; origins: string[] } {
  const listed = (config.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const origins = listed.length
    ? listed
    : [new URL(config.DASHBOARD_BASE_URL ?? "http://localhost:4100").origin];
  return {
    rpID: config.WEBAUTHN_RP_ID ?? new URL(origins[0]!).hostname,
    rpName: config.WEBAUTHN_RP_NAME,
    origins,
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalisePasskeyName(name: unknown): string {
  const cleaned = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  return cleaned.slice(0, PASSKEY_NAME_MAX).trim() || "Passkey";
}

/** Password managers that report an AAGUID, so the suggested name says where the passkey lives. */
const KNOWN_AAGUIDS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
};

/** "iCloud Keychain", else the browser it was made in ("Chrome on macOS"), else "Passkey". */
export function suggestPasskeyName(
  aaguid: string | null | undefined,
  userAgent?: string | null,
): string {
  const known = aaguid ? KNOWN_AAGUIDS[aaguid.toLowerCase()] : undefined;
  if (known) return known;
  const ua = describeUserAgent(userAgent);
  return ua === "Unknown browser" ? "Passkey" : ua;
}

const toView = (r: typeof userPasskeys.$inferSelect): PasskeyView => ({
  id: r.id,
  name: r.name,
  backedUp: r.backedUp,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

export async function listPasskeys(userId: string): Promise<PasskeyView[]> {
  const rows = await systemDb
    .select()
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId))
    .orderBy(asc(userPasskeys.createdAt), asc(userPasskeys.id));
  return rows.map(toView);
}

/** The person's stable WebAuthn user handle, minted on first use. */
async function webauthnUserId(userId: string): Promise<string> {
  const read = async () =>
    (
      await systemDb
        .select({ h: users.webauthnUserId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0];
  const existing = await read();
  if (!existing) throw new PasskeyError("Account not found.");
  if (existing.h) return existing.h;
  await systemDb
    .update(users)
    .set({ webauthnUserId: randomBytes(32).toString("base64url") })
    .where(and(eq(users.id, userId), isNull(users.webauthnUserId)));
  const created = await read();
  if (!created?.h) throw new PasskeyError("Account not found.");
  return created.h;
}

/** Park a ceremony's challenge. The returned handle is what the browser carries back. */
async function parkChallenge(
  purpose: "register" | "sign_in" | "second_step",
  challenge: string,
  userId: string | null,
): Promise<string> {
  const handle = randomBytes(32).toString("base64url");
  await systemDb.insert(webauthnChallenges).values({
    handleHash: sha256(handle),
    purpose,
    userId,
    challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return handle;
}

/**
 * Spend a challenge, whatever happens next: a ceremony that fails cannot be retried with the
 * same challenge, so a captured response is worth nothing a second time.
 */
async function takeChallenge(
  purpose: "register" | "sign_in" | "second_step",
  handle: string,
): Promise<{ challenge: string; userId: string | null } | null> {
  if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return null;
  const now = new Date();
  const [row] = await systemDb
    .update(webauthnChallenges)
    .set({ consumedAt: now })
    .where(
      and(
        eq(webauthnChallenges.handleHash, sha256(handle)),
        eq(webauthnChallenges.purpose, purpose),
        isNull(webauthnChallenges.consumedAt),
        gt(webauthnChallenges.expiresAt, now),
      ),
    )
    .returning({ challenge: webauthnChallenges.challenge, userId: webauthnChallenges.userId });
  return row ?? null;
}

const transportsOf = (t: string[]) => t as AuthenticatorTransportFuture[];

export async function registrationOptions(user: {
  id: string;
  email: string;
  name: string | null;
}): Promise<{ handle: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const rp = passkeyRp();
  const userHandle = await webauthnUserId(user.id);
  const existing = await systemDb
    .select({ id: userPasskeys.credentialId, transports: userPasskeys.transports })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, user.id));
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new Uint8Array(Buffer.from(userHandle, "base64url")),
    userName: user.email,
    userDisplayName: user.name?.trim() || user.email,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: transportsOf(c.transports) })),
    // Discoverable, so the same passkey can also sign in on its own.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  // Only the newest registration can finish.
  await systemDb
    .update(webauthnChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(webauthnChallenges.userId, user.id),
        eq(webauthnChallenges.purpose, "register"),
        isNull(webauthnChallenges.consumedAt),
      ),
    );
  return { handle: await parkChallenge("register", options.challenge, user.id), options };
}

/** A verified new credential, not yet stored: `service.ts` stores it in the 2FA transaction. */
export interface VerifiedPasskey {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean;
}

export async function verifyRegistration(
  userId: string,
  handle: string,
  response: RegistrationResponseJSON,
): Promise<VerifiedPasskey> {
  const pending = await takeChallenge("register", handle);
  if (!pending || pending.userId !== userId) {
    throw new PasskeyError("The time limit expired. Add the passkey again.", "expired");
  }
  const rp = passkeyRp();
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch (e) {
    if (/user verification/i.test((e as Error).message)) {
      throw new PasskeyError("This device cannot verify your identity.", "user_verification");
    }
    log.info("passkey registration refused", { user: userId, reason: (e as Error).message });
    throw new PasskeyError("The browser did not make the passkey. Try again.");
  }
  const info = v.registrationInfo;
  if (!v.verified || !info)
    throw new PasskeyError("The browser did not make the passkey. Try again.");
  if (info.userVerified !== true) {
    throw new PasskeyError("This device cannot verify your identity.", "user_verification");
  }
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey),
    counter: Number(info.credential.counter) || 0,
    transports: info.credential.transports ?? [],
    aaguid:
      info.aaguid && info.aaguid !== "00000000-0000-0000-0000-000000000000" ? info.aaguid : null,
    backedUp: !!info.credentialBackedUp,
  };
}

/**
 * Options for using a passkey. With a `userId` (the sign-in second step) only that person's
 * credentials are offered; without one (passkey sign-in) the browser offers any it holds for us.
 */
export async function authenticationOptions(
  purpose: "sign_in" | "second_step",
  userId: string | null = null,
): Promise<{ handle: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const credentials = userId
    ? await systemDb
        .select({ id: userPasskeys.credentialId, transports: userPasskeys.transports })
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, userId))
    : [];
  const options = await generateAuthenticationOptions({
    rpID: passkeyRp().rpID,
    userVerification: "required",
    allowCredentials: credentials.map((c) => ({
      id: c.id,
      transports: transportsOf(c.transports),
    })),
  });
  return { handle: await parkChallenge(purpose, options.challenge, userId), options };
}

/** Check an assertion. Returns whose passkey it was; throws `PasskeyError` otherwise. */
export async function verifyAuthentication(input: {
  purpose: "sign_in" | "second_step";
  handle: string;
  response: AuthenticationResponseJSON;
  /** The person the second step belongs to. */
  expectedUserId?: string | null;
  ctx?: SecurityContext;
}): Promise<{ userId: string; passkeyId: string }> {
  const pending = await takeChallenge(input.purpose, input.handle);
  if (!pending)
    throw new PasskeyError("The time limit expired. Use your passkey again.", "expired");
  const boundUser = pending.userId ?? input.expectedUserId ?? null;
  if (pending.userId && input.expectedUserId && pending.userId !== input.expectedUserId) {
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }
  const credentialId = input.response?.id;
  if (typeof credentialId !== "string" || !credentialId) {
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }
  const [row] = await systemDb
    .select({ p: userPasskeys, handle: users.webauthnUserId })
    .from(userPasskeys)
    .innerJoin(users, eq(users.id, userPasskeys.userId))
    .where(eq(userPasskeys.credentialId, credentialId))
    .limit(1);
  if (!row || (boundUser && row.p.userId !== boundUser)) {
    throw new PasskeyError(
      "This passkey is not linked to your account now. Use a different method.",
      "not_found",
    );
  }
  // A discoverable passkey names its owner; it must be the credential's owner.
  const userHandle = input.response.response?.userHandle;
  if (userHandle && row.handle && userHandle !== row.handle) {
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }

  const rp = passkeyRp();
  const stored = row.p.counter;
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    v = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      // 0 here, and the counter is judged below: only AFTER the signature checks out may a
      // regression be recorded, or anyone could forge one.
      credential: {
        id: row.p.credentialId,
        publicKey: new Uint8Array(row.p.publicKey),
        counter: 0,
        transports: transportsOf(row.p.transports),
      },
      requireUserVerification: true,
    });
  } catch (e) {
    log.info("passkey assertion refused", { user: row.p.userId, reason: (e as Error).message });
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }
  const info = v.authenticationInfo;
  if (!v.verified || info.userVerified !== true) {
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }

  const next = Number(info.newCounter) || 0;
  // Synced passkeys always send 0: no counter to advance, and the single-use challenge is what
  // stops a replay. Otherwise the counter must move forward, checked again in the UPDATE so two
  // parallel replays of one assertion cannot both pass.
  const regressed = (stored > 0 || next > 0) && next <= stored;
  let accepted = !regressed;
  if (accepted) {
    const updated = await systemDb
      .update(userPasskeys)
      .set({ counter: next, lastUsedAt: new Date(), backedUp: !!info.credentialBackedUp })
      .where(
        next === 0
          ? eq(userPasskeys.id, row.p.id)
          : and(eq(userPasskeys.id, row.p.id), lt(userPasskeys.counter, next)),
      )
      .returning({ id: userPasskeys.id });
    accepted = updated.length === 1;
  }
  if (!accepted) {
    // A cloned authenticator is the usual cause. Recorded, never emailed: it is evidence, and
    // the person cannot act on it beyond what the refusal already tells them.
    await recordSecurityEvent(row.p.userId, "passkey_counter_regression", input.ctx ?? {}, {
      passkey: row.p.id,
      stored_counter: stored,
      received_counter: next,
    });
    throw new PasskeyError("The passkey did not operate. Try again, or use a different method.");
  }
  return { userId: row.p.userId, passkeyId: row.p.id };
}

export async function renamePasskey(
  userId: string,
  id: string,
  name: unknown,
): Promise<PasskeyView> {
  const [row] = await systemDb
    .update(userPasskeys)
    .set({ name: normalisePasskeyName(name) })
    .where(and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId)))
    .returning();
  if (!row) throw new PasskeyError("This passkey is not on your account.", "not_found");
  return toView(row);
}

/** Drop finished and expired ceremonies. */
export async function sweepWebauthnChallenges(
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const res = await systemDb
    .delete(webauthnChallenges)
    .where(or(lt(webauthnChallenges.expiresAt, now), lt(webauthnChallenges.consumedAt, now)));
  return { deleted: (res as unknown as { count?: number }).count ?? 0 };
}
