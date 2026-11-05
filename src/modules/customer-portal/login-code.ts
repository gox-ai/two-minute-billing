/**
 * Portal sign-in by email code (storefront Phase 4, `storefront_config.portal_email_code`).
 *
 * A code the customer TYPES, never a link: mail scanners open links before the person does,
 * which is why the emailed magic link was removed (README § "Self-serve access"). Typing
 * cannot be done in advance.
 *
 * - The request never says whether the email has an account.
 * - 6 digits, 10 minutes, 5 wrong tries, single use; a new request voids the previous code.
 *   Only hashes are stored.
 * - One email can belong to several customers of a business; the customer then selects one.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, portalLoginCodes } from "@db/schema";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { sendSignInCode } from "@/modules/emails/sign-in-code";
import { decryptSecret, encryptSecret } from "@/platform/secrets";
import { createPortalSession, exchangePortalAccessToken, findPortalBusiness } from "./service";

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

export class PortalLoginError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "PortalLoginError";
  }
}

/** One answer for every way a code can fail, so a guesser learns nothing. */
const BAD_CODE = "The code is not correct or it expired. Ask for a new code.";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const loginEmailHash = (email: string) => sha256(normalizeEmail(email));
const codeHash = (rowId: string, code: string) => sha256(`${rowId}:${code}`);

async function business(businessPublicId: string) {
  const biz = await findPortalBusiness(businessPublicId);
  if (!biz || !resolveStorefrontConfig(biz).portalEmailCode)
    throw new PortalLoginError("Sign-in by email code is not available for this account.", 404);
  return biz;
}

/** Customers of the business with this email who may sign in (not archived). */
async function matchingCustomers(organizationId: string, businessId: string, email: string) {
  return withTenant(organizationId, (tx) =>
    tx
      .select({
        id: customers.id,
        publicId: customers.publicId,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        company: customers.company,
      })
      .from(customers)
      .where(
        and(
          eq(customers.businessId, businessId),
          eq(customers.active, true),
          sql`lower(${customers.email}) = ${normalizeEmail(email)}`,
        ),
      )
      .orderBy(customers.createdAt),
  );
}

export const SIGN_IN_CODE_TASK = "portal_sign_in_code_send";

/** The queued send. The code travels encrypted: the jobs table never holds it in plain text. */
export interface SignInCodeJob {
  organizationId: string;
  businessId: string;
  codeId: string;
  customerId: string;
  to: string;
  code: string;
}

/**
 * Send a sign-in code when the email belongs to a customer. Resolves the same way either
 * way; rate limits are the route's job. The email goes through the job queue, so the
 * response time does not show whether the email has an account.
 */
export async function requestPortalLoginCode(businessPublicId: string, email: string) {
  const biz = await business(businessPublicId);
  const matches = await matchingCustomers(biz.organizationId, biz.id, email);
  if (matches.length === 0) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = loginEmailHash(email);
  const now = new Date();
  const codeId = await withTenant(biz.organizationId, async (tx) => {
    // A new code voids the previous one.
    await tx
      .update(portalLoginCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(portalLoginCodes.businessId, biz.id),
          eq(portalLoginCodes.emailHash, hash),
          isNull(portalLoginCodes.usedAt),
        ),
      );
    const [row] = await tx
      .insert(portalLoginCodes)
      .values({
        organizationId: biz.organizationId,
        businessId: biz.id,
        emailHash: hash,
        codeHash: "pending",
        expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS),
      })
      .returning({ id: portalLoginCodes.id });
    await tx
      .update(portalLoginCodes)
      .set({ codeHash: codeHash(row!.id, code) })
      .where(eq(portalLoginCodes.id, row!.id));
    return row!.id;
  });
  const job: SignInCodeJob = {
    organizationId: biz.organizationId,
    businessId: biz.id,
    codeId,
    customerId: matches[0]!.id,
    to: matches[0]!.email ?? normalizeEmail(email),
    code: encryptSecret(code),
  };
  const { enqueue } = await import("@/platform/jobs");
  await enqueue(SIGN_IN_CODE_TASK, job, {
    jobKey: `portal_sign_in_code:${codeId}`,
    maxAttempts: 3,
  });
}

/** The worker half: send the code unless it was used, replaced or expired meanwhile. */
export async function sendQueuedSignInCode(job: SignInCodeJob): Promise<"sent" | "skipped"> {
  const [row] = await withTenant(job.organizationId, (tx) =>
    tx
      .select({ usedAt: portalLoginCodes.usedAt, expiresAt: portalLoginCodes.expiresAt })
      .from(portalLoginCodes)
      .where(eq(portalLoginCodes.id, job.codeId))
      .limit(1),
  );
  if (!row || row.usedAt || row.expiresAt <= new Date()) return "skipped";
  const sent = await sendSignInCode(job.organizationId, job.businessId, {
    customerId: job.customerId,
    to: job.to,
    code: decryptSecret(job.code),
  });
  return sent ? "sent" : "skipped";
}

export type PortalLoginResult =
  | { kind: "session"; token: string; expiresAt: Date }
  | { kind: "choose"; customers: Array<{ id: string; name: string }> };

/**
 * Check a code. With several customers on the email and none selected, answers the list
 * and keeps the code; selecting one spends it and opens the session.
 */
export async function verifyPortalLoginCode(input: {
  businessPublicId: string;
  email: string;
  code: string;
  customer?: string;
  ip?: string | null;
}): Promise<PortalLoginResult> {
  const biz = await business(input.businessPublicId);
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) throw new PortalLoginError(BAD_CODE);
  const hash = loginEmailHash(input.email);
  const now = new Date();
  const [row] = await withTenant(biz.organizationId, (tx) =>
    tx
      .select()
      .from(portalLoginCodes)
      .where(
        and(
          eq(portalLoginCodes.businessId, biz.id),
          eq(portalLoginCodes.emailHash, hash),
          isNull(portalLoginCodes.usedAt),
          gt(portalLoginCodes.expiresAt, now),
        ),
      )
      .orderBy(desc(portalLoginCodes.createdAt))
      .limit(1),
  );
  if (!row) throw new PortalLoginError(BAD_CODE);
  // Claim a try before comparing, so parallel guesses cannot all read the same count.
  const [claimed] = await withTenant(biz.organizationId, (tx) =>
    tx
      .update(portalLoginCodes)
      .set({ attempts: sql`${portalLoginCodes.attempts} + 1` })
      .where(
        and(
          eq(portalLoginCodes.id, row.id),
          lt(portalLoginCodes.attempts, LOGIN_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning({ id: portalLoginCodes.id }),
  );
  if (!claimed) throw new PortalLoginError(BAD_CODE);
  const ok = timingSafeEqual(Buffer.from(codeHash(row.id, code)), Buffer.from(row.codeHash));
  if (!ok) throw new PortalLoginError(BAD_CODE);
  // Only a wrong code costs a try: give it back, so the "choose an account" step still works.
  await withTenant(biz.organizationId, (tx) =>
    tx
      .update(portalLoginCodes)
      .set({ attempts: sql`${portalLoginCodes.attempts} - 1` })
      .where(eq(portalLoginCodes.id, row.id)),
  );
  const matches = await matchingCustomers(biz.organizationId, biz.id, input.email);
  if (matches.length === 0) throw new PortalLoginError(BAD_CODE);
  if (matches.length > 1 && !input.customer)
    return {
      kind: "choose",
      customers: matches.map((m) => ({
        id: m.publicId,
        name: m.company || [m.firstName, m.lastName].filter(Boolean).join(" ") || m.publicId,
      })),
    };
  const chosen = input.customer ? matches.find((m) => m.publicId === input.customer) : matches[0];
  if (!chosen) throw new PortalLoginError("Select one of the accounts in the list.");
  // Spend the code once, even if two requests race.
  const [spent] = await withTenant(biz.organizationId, (tx) =>
    tx
      .update(portalLoginCodes)
      .set({ usedAt: now })
      .where(and(eq(portalLoginCodes.id, row.id), isNull(portalLoginCodes.usedAt)))
      .returning({ id: portalLoginCodes.id }),
  );
  if (!spent) throw new PortalLoginError(BAD_CODE);
  const ticket = await createPortalSession({
    organizationId: biz.organizationId,
    businessId: biz.id,
    customerId: chosen.id,
  });
  const session = await exchangePortalAccessToken(ticket.accessToken, input.ip ?? null);
  if (!session) throw new PortalLoginError(BAD_CODE);
  return { kind: "session", token: session.token, expiresAt: session.expiresAt };
}
