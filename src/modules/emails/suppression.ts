/**
 * Delivery feedback that arrives AFTER the send — bounces and complaints.
 *
 * The send path can only see a synchronous refusal. A hard bounce reaches us minutes to
 * hours later over SNS, by which time the row already says `sent` and carries a provider
 * message id. This module is what turns that late feedback into two durable facts: the
 * message is marked, and the address is suppressed so the NEXT send never goes out.
 *
 * Suppression is the half that protects the sending account. SES publishes a bounce rate and
 * pauses accounts that exceed it, so continuing to mail addresses the provider has already
 * called dead is not merely untidy — it is how one merchant's stale list suspends everyone's
 * sending. It is also why suppression is visible and removable rather than permanent: a
 * mailbox that was full in March may be fine in June, and an invisible block that nobody can
 * lift is its own failure mode.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { emailMessages, emailSuppressions } from "@db/schema";
import { createLogger } from "@/platform/logger";
import type { SesFeedback } from "./sns";

const log = createLogger("emails.suppression");

/**
 * Is this address suppressed for this business?
 *
 * Compared case-insensitively against the stored value, matching the unique index. The
 * `lower()` on both sides is what makes the guarantee independent of how the caller happened
 * to capitalise the address.
 */
export async function isSuppressed(businessId: string, address: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.businessId, businessId),
        sql`lower(${emailSuppressions.address}) = lower(${address})`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Add an address to the suppression list. Idempotent — a redelivered SNS notification, or a
 * second bounce for the same address, must not fail or duplicate.
 *
 * The conflict target is the EXPRESSION index `(business_id, lower(address))`, not the bare
 * columns, so it matches however the address was capitalised.
 */
export async function suppressAddress(input: {
  organizationId: string;
  businessId: string;
  address: string;
  reason: "bounce" | "complaint" | "manual";
  detail?: string | null;
  sourceEmailId?: string | null;
}): Promise<void> {
  await withTenant(input.organizationId, async (tx) => {
    await tx
      .insert(emailSuppressions)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        // Stored lowercased as well as compared that way, so the table reads consistently.
        address: input.address.trim().toLowerCase(),
        reason: input.reason,
        detail: input.detail ?? null,
        sourceEmailId: input.sourceEmailId ?? null,
      })
      .onConflictDoNothing();
  });
}

/**
 * The business's suppression list, newest first.
 *
 * Exists because an invisible block is its own failure mode: "we stopped emailing this
 * customer and nobody can say why" is a support call that no amount of correct bounce
 * handling excuses. Small by nature — a healthy list is a handful of rows — so it is
 * returned whole rather than paginated.
 */
export async function listSuppressions(organizationId: string, businessId: string) {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.businessId, businessId))
      .orderBy(desc(emailSuppressions.createdAt))
      .limit(500),
  );
}

/** Lift a suppression — the customer fixed their mailbox, or it was added by mistake. */
export async function unsuppressAddress(
  organizationId: string,
  businessId: string,
  address: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const gone = await tx
      .delete(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.businessId, businessId),
          sql`lower(${emailSuppressions.address}) = lower(${address})`,
        ),
      )
      .returning({ id: emailSuppressions.id });
    return gone.length > 0;
  });
}

export interface FeedbackOutcome {
  /** The message the feedback was about, if we could correlate one. */
  emailId: string | null;
  marked: boolean;
  suppressed: number;
}

/**
 * Apply one parsed SES notification.
 *
 * Correlates on the PROVIDER's message id, which is the only identifier both sides share —
 * `email_messages.provider_message_id` is exactly what `SesMailer.send` recorded. A
 * notification we cannot correlate is still acted on for SUPPRESSION (the address is bad
 * regardless of which message revealed it), just without marking a row: dropping it because
 * the message predates this feature would keep mailing a known-dead address.
 */
export async function applySesFeedback(fb: SesFeedback): Promise<FeedbackOutcome> {
  const out: FeedbackOutcome = { emailId: null, marked: false, suppressed: 0 };
  // A delivery confirmation is not acted on: the row already says `sent`, and re-asserting
  // that adds no fact. Recorded here only so the caller can count it.
  if (fb.kind === "delivery") return out;

  const [row] = fb.providerMessageId
    ? await systemDb
        .select({
          id: emailMessages.id,
          publicId: emailMessages.publicId,
          organizationId: emailMessages.organizationId,
          businessId: emailMessages.businessId,
          toAddress: emailMessages.toAddress,
        })
        .from(emailMessages)
        .where(eq(emailMessages.providerMessageId, fb.providerMessageId))
        .limit(1)
    : [];

  if (row) {
    out.emailId = row.publicId;
    await withTenant(row.organizationId, async (tx) => {
      await tx
        .update(emailMessages)
        .set({
          bounceType: fb.bounceType,
          // `bounced` ONLY for a permanent refusal or a complaint. A transient bounce keeps
          // its `sent` status: the message WAS delivered to the provider and may yet arrive,
          // and relabelling it would tell the merchant their customer's address is bad when
          // the mailbox was merely full.
          ...(fb.suppress ? { status: "bounced" } : {}),
          lastError: fb.detail,
        })
        .where(eq(emailMessages.id, row.id));
    });
    out.marked = true;
  }

  if (!fb.suppress) return out;

  // Suppress every recipient the provider named. Falls back to the row's own recipient when
  // the payload named none — a bounce with no recipient list still tells us this address
  // failed, and that is the whole point of acting on it.
  const addresses =
    fb.recipients.length > 0 ? fb.recipients : row?.toAddress ? [row.toAddress] : [];
  if (addresses.length === 0 || !row?.businessId) {
    if (addresses.length > 0) {
      log.warn("SES feedback could not be attributed to a business — not suppressing", {
        providerMessageId: fb.providerMessageId,
        kind: fb.kind,
      });
    }
    return out;
  }

  for (const address of addresses) {
    await suppressAddress({
      organizationId: row.organizationId,
      businessId: row.businessId,
      address,
      reason: fb.kind === "complaint" ? "complaint" : "bounce",
      detail: fb.detail,
      sourceEmailId: row.id,
    });
    out.suppressed++;
  }
  log.info("suppressed an address after provider feedback", {
    event: "email_address_suppressed",
    kind: fb.kind,
    detail: fb.detail,
    count: out.suppressed,
  });
  return out;
}
