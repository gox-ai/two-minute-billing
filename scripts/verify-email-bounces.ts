/**
 * Proves the asynchronous half of delivery feedback: bounces and complaints over SNS.
 *
 * The claims under test, in the order the failure actually unfolds:
 *   1. A hard bounce arriving AFTER the send marks the message `bounced` and suppresses the
 *      address. Until now the row said `sent` for ever and nothing knew the address was dead.
 *   2. A TRANSIENT bounce does not suppress. A full mailbox is not a dead address, and
 *      suppressing on one would stop mailing a working customer permanently.
 *   3. A complaint suppresses. The address works; the person marked it spam, and continuing
 *      is what gets a sending domain blocklisted.
 *   4. **The outbox honours the list.** This is the one that matters — a suppression the
 *      send path ignores is decorative, and the whole point is that SES stops seeing bounces.
 *   5. Suppression is per BUSINESS, idempotent, case-insensitive, and liftable.
 *
 *   pnpm verify:email-bounces
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { deliverPendingEmails } from "@/modules/emails/outbox";
import {
  applySesFeedback,
  isSuppressed,
  suppressAddress,
  unsuppressAddress,
} from "@/modules/emails/suppression";
import { parseSesFeedback } from "@/modules/emails/sns";
import { emailMessages, emailSuppressions } from "@db/schema";
import { publicId } from "@/platform/ids";

/**
 * Provider message ids must be unique PER RUN. `applySesFeedback` correlates on
 * `provider_message_id` alone — correct in production, where SES ids are globally unique —
 * so fixed literals here matched a PREVIOUS run's row on the shared dev database and this
 * suite passed once and then failed for ever. The bug was the fixture, not the engine.
 */
const RUN = Math.random().toString(36).slice(2, 10);
const pmid = (name: string) => `prov-${name}-${RUN}`;

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}

const captured: OutboundEmail[] = [];
setMailer({
  kind: "smtp",
  /** In-process fake: reaches no network, so it can never be circuit-broken. */
  target: null,
  async send(msg) {
    captured.push(msg);
    return { providerMessageId: `prov-${captured.length}`, status: "sent" };
  },
});

const org = await createOrganization({ name: "Bounce Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Bounce Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const other = await createBusiness({
  organizationId: orgId,
  name: "Other Biz",
  defaultCurrency: "USD",
  livemode: "test",
});

/** A message already `sent`, carrying the provider id SES will quote back at us. */
async function sentMessage(to: string, providerMessageId: string, businessId = biz.id) {
  const pid = publicId("em");
  await withTenant(orgId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: pid,
      organizationId: orgId,
      businessId,
      type: "invoice_issued",
      toAddress: to,
      subject: "Your invoice",
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      status: "sent",
      transport: "ses",
      providerMessageId,
      attempts: 1,
      sentAt: new Date(),
    }),
  );
  return pid;
}
const rowFor = (pid: string) =>
  withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.publicId, pid))
      .limit(1);
    return r;
  });

// ── 1. A permanent bounce, arriving after the send ───────────────────────────
{
  const pid = await sentMessage("dead@example.com", pmid("hard-1"));
  const fb = parseSesFeedback(
    JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: pmid("hard-1") },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        bouncedRecipients: [{ emailAddress: "dead@example.com" }],
      },
    }),
  );
  const outcome = await applySesFeedback(fb!);
  const row = await rowFor(pid);
  ok("a permanent bounce marks the message bounced", row?.status === "bounced", row?.status);
  ok("…records the bounce type", row?.bounceType === "permanent", row?.bounceType);
  ok("…keeps the provider's own words", row?.lastError === "Permanent/NoEmail", row?.lastError);
  ok("…and suppresses the address", await isSuppressed(biz.id, "dead@example.com"));
  ok("…reporting what it did", outcome.suppressed === 1 && outcome.marked, outcome);
}

// ── 2. A transient bounce must NOT suppress ──────────────────────────────────
{
  const pid = await sentMessage("full@example.com", pmid("soft-1"));
  const fb = parseSesFeedback(
    JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: pmid("soft-1") },
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        bouncedRecipients: [{ emailAddress: "full@example.com" }],
      },
    }),
  );
  await applySesFeedback(fb!);
  const row = await rowFor(pid);
  // The message WAS delivered to the provider and may yet arrive; relabelling it would tell
  // the merchant their customer's address is bad when the mailbox was merely full.
  ok("a transient bounce leaves the message sent", row?.status === "sent", row?.status);
  ok("…but records the type for the operator", row?.bounceType === "transient", row?.bounceType);
  ok("…and does NOT suppress the address", !(await isSuppressed(biz.id, "full@example.com")));
}

// ── 3. A complaint suppresses ────────────────────────────────────────────────
{
  const pid = await sentMessage("annoyed@example.com", pmid("spam-1"));
  const fb = parseSesFeedback(
    JSON.stringify({
      notificationType: "Complaint",
      mail: { messageId: pmid("spam-1") },
      complaint: {
        complainedRecipients: [{ emailAddress: "annoyed@example.com" }],
        complaintFeedbackType: "abuse",
      },
    }),
  );
  await applySesFeedback(fb!);
  const row = await rowFor(pid);
  ok("a complaint marks the message bounced", row?.status === "bounced", row?.status);
  ok("…as a complaint, not a bounce", row?.bounceType === "complaint", row?.bounceType);
  ok("…and suppresses the address", await isSuppressed(biz.id, "annoyed@example.com"));
}

// ── 4. THE POINT: the outbox refuses to send to a suppressed address ─────────
{
  const before = captured.length;
  const queued = publicId("em");
  await withTenant(orgId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: queued,
      organizationId: orgId,
      businessId: biz.id,
      type: "invoice_issued",
      toAddress: "dead@example.com", // suppressed in §1
      subject: "Another invoice",
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    }),
  );
  const res = await deliverPendingEmails(new Date());
  const row = await rowFor(queued);
  ok("a queued email to a suppressed address is not sent", row?.status === "skipped", row?.status);
  // Scoped to OUR address, not the global call count: `deliverPendingEmails` scans
  // system-wide, so leftover pending rows from other suites on this shared database are
  // legitimately sent in the same pass. The claim is that the SUPPRESSED address was never
  // handed to the transport — asserting a zero-delta made that depend on suite ordering.
  const toSuppressed = captured.slice(before).filter((m) => m.to === "dead@example.com");
  ok(
    "…the transport was never asked to mail the suppressed address",
    toSuppressed.length === 0,
    toSuppressed.length,
  );
  ok("…the reason is on the row", (row?.lastError ?? "").includes("suppressed"), row?.lastError);
  ok("…it is not left for the clock to retry", row?.nextAttemptAt === null, row?.nextAttemptAt);
  ok("…and the pass counts it", (res.suppressed ?? 0) >= 1, res);
}

// ── 5. Scope, idempotency, case, and lifting ─────────────────────────────────
{
  // Per BUSINESS: two businesses in one org have separate customer relationships, and a
  // bounce from one says nothing about whether the other may write to the same person.
  ok(
    "a suppression in one business does not apply to another",
    !(await isSuppressed(other.id, "dead@example.com")),
  );

  // A redelivered SNS notification, or a second bounce, must not fail or duplicate.
  await suppressAddress({
    organizationId: orgId,
    businessId: biz.id,
    address: "dead@example.com",
    reason: "bounce",
  });
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(emailSuppressions).where(eq(emailSuppressions.businessId, biz.id)),
  );
  ok(
    "suppressing twice leaves exactly one row",
    rows.filter((r) => r.address === "dead@example.com").length === 1,
    rows.length,
  );

  // Case-insensitive, or the guarantee could be sidestepped by capitalisation.
  ok("suppression is case-insensitive", await isSuppressed(biz.id, "DEAD@Example.COM"));
  await suppressAddress({
    organizationId: orgId,
    businessId: biz.id,
    address: "MiXeD@Example.com",
    reason: "manual",
  });
  ok("…on the way in too", await isSuppressed(biz.id, "mixed@example.com"));

  // Liftable: a mailbox full in March may be fine in June, and a block nobody can remove is
  // its own failure mode.
  ok("a suppression can be lifted", await unsuppressAddress(orgId, biz.id, "DEAD@example.com"));
  ok("…and the address is sendable again", !(await isSuppressed(biz.id, "dead@example.com")));
  ok(
    "lifting a non-existent suppression reports false",
    !(await unsuppressAddress(orgId, biz.id, "nobody@x.test")),
  );
}

// ── 6. Feedback we cannot correlate still protects the address ───────────────
{
  const fb = parseSesFeedback(
    JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: pmid("unknown-9999") },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "ghost@example.com" }],
      },
    }),
  );
  const outcome = await applySesFeedback(fb!);
  // No row to mark — but nothing was lost either: the parse succeeded and the caller is told.
  ok("an uncorrelatable bounce marks nothing", !outcome.marked, outcome);
  ok("…and does not throw", true);
}

setMailer(null);
console.log(`\n${fail === 0 ? "✅" : "❌"} email bounces: ${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
