/**
 * Support requests (Cloud only, 0512). The assistant drafts a request on a card; the member
 * edits it, removes any attached item and sends it. Our staff answer from the back-office; the
 * member reads the thread in the assistant panel. A staff reply is shown as written and is never
 * given to the model.
 *
 * Member paths run inside `withTenant` and only ever see the member's own requests. Staff paths
 * (`…ForStaff`) use the system connection: the back-office reads across organizations.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withTenant, systemDb } from "@/platform/db";
import { getTraceId } from "@/platform/trace";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import { isCloud } from "@/platform/edition";
import { createLogger } from "@/platform/logger";
import {
  assistantAttachments,
  assistantConversations,
  assistantMessages,
  businesses,
  organizations,
  supportMessages,
  supportRequests,
  users,
} from "@db/schema";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { accountBrand } from "@/modules/emails/account-brand";
import { renderSupportReplyEmail } from "@/modules/emails/templates";
import {
  cleanText,
  keptItems,
  supportReference,
  type SupportDraft,
  type SupportItem,
} from "./support-context";

const log = createLogger("assistant.support");

/** Support requests are part of our hosted service: a self-hosted install has no one to send to. */
export const supportOffered = (): boolean => isCloud();

/** How every staff reply is signed to the member: never a person's name or address. */
export const SUPPORT_SIGNATURE = "Two Minute Billing support";

export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;
export const MAX_ATTACHMENTS = 3;

export class SupportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SupportError";
  }
}

export type SupportRequestRow = typeof supportRequests.$inferSelect;
export type SupportMessageRow = typeof supportMessages.$inferSelect;
export type SupportStatus = "open" | "waiting" | "resolved";
type AttachmentMeta = { id: string; name: string; content_type: string; size: number };

// ── member side ─────────────────────────────────────────────────────────────────

type TenantTx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Queue the staff notices for a member message, in the transaction that stores it (0513): one
 * `support_notice_send` job per channel, sent by the engine worker (`support-notify.ts`).
 */
async function queueSupportNotice(tx: TenantTx, messageId: string): Promise<void> {
  await tx.execute(
    sql`select public.app_queue_support_notice(${messageId}::uuid, ${getTraceId() ?? null})`,
  );
}

/** The member's own screenshots in this business, for a request or a reply. */
async function ownAttachments(
  tx: TenantTx,
  a: { businessId: string; userId: string; ids: string[] },
): Promise<AttachmentMeta[]> {
  if (!a.ids.length) return [];
  const rows = await tx
    .select({
      id: assistantAttachments.publicId,
      name: assistantAttachments.name,
      content_type: assistantAttachments.contentType,
      size: assistantAttachments.size,
    })
    .from(assistantAttachments)
    .where(
      and(
        inArray(assistantAttachments.publicId, a.ids),
        eq(assistantAttachments.businessId, a.businessId),
        eq(assistantAttachments.userId, a.userId),
      ),
    );
  if (rows.length !== new Set(a.ids).size)
    throw new SupportError("We could not find an attached screenshot. Attach it again.", 404);
  return rows;
}

/**
 * Send a drafted request. The draft is read from the stored assistant message, so the context is
 * what the server collected, less what the member removed. A repeat with the same idempotency key
 * returns the first request and sends nothing again.
 */
export async function createSupportRequest(input: {
  organizationId: string;
  userId: string;
  businessId: string;
  conversationId: string;
  draftId: string;
  subject: string;
  description: string;
  remove: string[];
  attachments: string[];
  idempotencyKey: string;
  now?: Date;
}): Promise<{ request: SupportRequestRow; replayed: boolean }> {
  const now = input.now ?? new Date();
  const same = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(supportRequests)
      .where(
        and(
          eq(supportRequests.organizationId, input.organizationId),
          eq(supportRequests.userId, input.userId),
          eq(supportRequests.idempotencyKey, input.idempotencyKey),
        ),
      ),
  );
  if (same[0]) return { request: same[0], replayed: true };

  const subject = cleanText(input.subject, SUBJECT_MAX);
  const description = cleanText(input.description, BODY_MAX);
  if (!subject) throw new SupportError("Write a subject.");
  if (!description) throw new SupportError("Write what happened.");

  try {
    return await withTenant(input.organizationId, async (tx) => {
      const [msg] = await tx
        .select({ id: assistantMessages.id, extras: assistantMessages.extras })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.conversationId, input.conversationId),
            sql`${assistantMessages.extras} -> 'support_draft' ->> 'id' = ${input.draftId}`,
          ),
        )
        .for("update");
      const draft = (msg?.extras as { support_draft?: SupportDraft } | null)?.support_draft;
      if (!msg || !draft) throw new SupportError("We could not find this request.", 404);
      if (draft.sent) throw new SupportError("You sent this request already.", 409);
      const items = keptItems(draft.items, input.remove);
      const attachments = await ownAttachments(tx, {
        businessId: input.businessId,
        userId: input.userId,
        ids: input.attachments,
      });
      const [req] = await tx
        .insert(supportRequests)
        .values({
          publicId: publicId("sr"),
          organizationId: input.organizationId,
          businessId: input.businessId,
          userId: input.userId,
          conversationId: items.some((i) => i.kind === "conversation")
            ? input.conversationId
            : null,
          subject,
          status: "open",
          context: items,
          idempotencyKey: input.idempotencyKey,
          lastMemberReplyAt: now,
        })
        .returning();
      const [first] = await tx
        .insert(supportMessages)
        .values({
          publicId: publicId("srm"),
          organizationId: input.organizationId,
          requestId: req!.id,
          authorKind: "member",
          body: description,
          attachments: attachments.length ? attachments : null,
        })
        .returning({ id: supportMessages.id });
      await queueSupportNotice(tx, first!.id);
      const sent = {
        id: req!.publicId,
        reference: supportReference(req!.number),
        at: now.toISOString(),
      };
      await tx
        .update(assistantMessages)
        .set({
          extras: sql`jsonb_set(${assistantMessages.extras}, '{support_draft,sent}', ${JSON.stringify(sent)}::jsonb)`,
        })
        .where(eq(assistantMessages.id, msg.id));
      log.info("support request sent", {
        request: req!.publicId,
        organizationId: input.organizationId,
      });
      return { request: req!, replayed: false };
    });
  } catch (e) {
    // Two sends racing on one key: the loser returns the winner's request.
    if ((e as { code?: string })?.code === "23505") {
      const [r] = await withTenant(input.organizationId, (tx) =>
        tx
          .select()
          .from(supportRequests)
          .where(
            and(
              eq(supportRequests.userId, input.userId),
              eq(supportRequests.idempotencyKey, input.idempotencyKey),
            ),
          ),
      );
      if (r) return { request: r, replayed: true };
    }
    throw e;
  }
}

/** The member's requests in this organization, newest activity first. */
export async function listMemberRequests(organizationId: string, userId: string) {
  return withTenant(organizationId, (tx) =>
    tx
      .select({ r: supportRequests, business: businesses.publicId })
      .from(supportRequests)
      .innerJoin(businesses, eq(businesses.id, supportRequests.businessId))
      .where(eq(supportRequests.userId, userId))
      .orderBy(desc(supportRequests.updatedAt))
      .limit(100),
  );
}

/** Requests with a staff reply the member has not read. */
export async function memberUnread(organizationId: string, userId: string): Promise<number> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ n: sql<string>`count(*)` })
      .from(supportRequests)
      .where(and(eq(supportRequests.userId, userId), isNotNull(supportRequests.memberUnreadAt))),
  );
  return Number(row?.n ?? 0);
}

/** One of the member's own requests with its thread, or null. */
export async function getMemberRequest(organizationId: string, userId: string, id: string) {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ r: supportRequests, business: businesses.publicId })
      .from(supportRequests)
      .innerJoin(businesses, eq(businesses.id, supportRequests.businessId))
      .where(and(eq(supportRequests.publicId, id), eq(supportRequests.userId, userId)));
    if (!row) return null;
    const messages = await tx
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.requestId, row.r.id))
      .orderBy(asc(supportMessages.createdAt));
    return { ...row, messages };
  });
}

/** The member answers in the thread. A reply opens a resolved request again. */
export async function replyAsMember(input: {
  organizationId: string;
  userId: string;
  id: string;
  body: string;
  attachments: string[];
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const body = cleanText(input.body, BODY_MAX);
  if (!body) throw new SupportError("Write a reply.");
  await withTenant(input.organizationId, async (tx) => {
    const [r] = await tx
      .select()
      .from(supportRequests)
      .where(and(eq(supportRequests.publicId, input.id), eq(supportRequests.userId, input.userId)))
      .for("update");
    if (!r) throw new SupportError("We could not find this request.", 404);
    const attachments = await ownAttachments(tx, {
      businessId: r.businessId,
      userId: input.userId,
      ids: input.attachments,
    });
    const [msg] = await tx
      .insert(supportMessages)
      .values({
        publicId: publicId("srm"),
        organizationId: input.organizationId,
        requestId: r.id,
        authorKind: "member",
        body,
        attachments: attachments.length ? attachments : null,
      })
      .returning({ id: supportMessages.id });
    await queueSupportNotice(tx, msg!.id);
    await tx
      .update(supportRequests)
      .set({ status: "open", resolvedAt: null, lastMemberReplyAt: now, memberUnreadAt: null })
      .where(eq(supportRequests.id, r.id));
  });
}

/** The member read the thread: the unread dot goes. */
export async function markMemberRead(organizationId: string, userId: string, id: string) {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .update(supportRequests)
      .set({ memberUnreadAt: null })
      .where(and(eq(supportRequests.publicId, id), eq(supportRequests.userId, userId)))
      .returning({ id: supportRequests.id }),
  );
  return rows.length > 0;
}

/** What the member's browser receives. Staff are "Two Minute Billing support", never a person. */
export function serializeForMember(
  r: SupportRequestRow,
  business: string,
  messages?: SupportMessageRow[],
) {
  return {
    object: "support_request" as const,
    id: r.publicId,
    reference: supportReference(r.number),
    subject: r.subject,
    status: r.status as SupportStatus,
    business,
    context: (r.context as SupportItem[]).map(({ key, kind, label }) => ({ key, kind, label })),
    unread: !!r.memberUnreadAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    last_staff_reply_at: r.lastStaffReplyAt,
    ...(messages
      ? {
          messages: messages.map((m) => ({
            id: m.publicId,
            author:
              m.authorKind === "staff"
                ? ("support" as const)
                : (m.authorKind as "member" | "system"),
            author_name: m.authorKind === "staff" ? SUPPORT_SIGNATURE : null,
            body: m.body,
            attachments: (m.attachments as AttachmentMeta[] | null) ?? [],
            created_at: m.createdAt,
          })),
        }
      : {}),
  };
}

// ── staff side (back-office, system connection) ─────────────────────────────────

export interface StaffRequestRow {
  request: SupportRequestRow;
  organization: { id: string; publicId: string; name: string };
  business: { publicId: string; name: string; livemode: string };
  member: { email: string; name: string | null };
}

const staffSelect = {
  request: supportRequests,
  orgId: organizations.id,
  orgPublicId: organizations.publicId,
  orgName: organizations.name,
  bizPublicId: businesses.publicId,
  bizName: businesses.name,
  bizLivemode: businesses.livemode,
  memberEmail: users.email,
  memberName: users.name,
};

type StaffJoin = {
  request: SupportRequestRow;
  orgId: string;
  orgPublicId: string;
  orgName: string;
  bizPublicId: string;
  bizName: string;
  bizLivemode: string;
  memberEmail: string | null;
  memberName: string | null;
};

const toStaffRow = (r: StaffJoin): StaffRequestRow => ({
  request: r.request,
  organization: { id: r.orgId, publicId: r.orgPublicId, name: r.orgName },
  business: { publicId: r.bizPublicId, name: r.bizName, livemode: r.bizLivemode },
  member: { email: r.memberEmail ?? "", name: r.memberName },
});

function staffQuery() {
  return systemDb
    .select(staffSelect)
    .from(supportRequests)
    .innerJoin(organizations, eq(organizations.id, supportRequests.organizationId))
    .innerJoin(businesses, eq(businesses.id, supportRequests.businessId))
    .leftJoin(users, eq(users.id, supportRequests.userId));
}

export async function listForStaff(status?: SupportStatus): Promise<StaffRequestRow[]> {
  const rows = await staffQuery()
    .where(status ? eq(supportRequests.status, status) : undefined)
    .orderBy(desc(supportRequests.updatedAt))
    .limit(500);
  return rows.map(toStaffRow);
}

export async function getForStaff(id: string) {
  const [row] = await staffQuery().where(eq(supportRequests.publicId, id));
  if (!row) return null;
  const messages = await systemDb
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.requestId, row.request.id))
    .orderBy(asc(supportMessages.createdAt));
  // The source conversation, only when the member left it attached.
  const conversation = row.request.conversationId
    ? await systemDb
        .select({
          role: assistantMessages.role,
          content: assistantMessages.content,
          createdAt: assistantMessages.createdAt,
        })
        .from(assistantMessages)
        .innerJoin(
          assistantConversations,
          eq(assistantConversations.id, assistantMessages.conversationId),
        )
        .where(eq(assistantMessages.conversationId, row.request.conversationId))
        .orderBy(asc(assistantMessages.createdAt))
        .limit(200)
    : [];
  return { ...toStaffRow(row), messages, conversation };
}

/** A screenshot on a request, for the back-office page. Null when it is not on that request. */
export async function attachmentForStaff(requestId: string, attachmentId: string) {
  const r = await getForStaff(requestId);
  const on = r?.messages.some((m) =>
    ((m.attachments as AttachmentMeta[] | null) ?? []).some((a) => a.id === attachmentId),
  );
  if (!r || !on) return null;
  const [a] = await systemDb
    .select({ contentType: assistantAttachments.contentType, data: assistantAttachments.data })
    .from(assistantAttachments)
    .where(
      and(
        eq(assistantAttachments.publicId, attachmentId),
        eq(assistantAttachments.organizationId, r.organization.id),
      ),
    );
  return a ?? null;
}

const memberLink = (r: SupportRequestRow, business: string) => {
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/businesses/${business}?support=${r.publicId}` : null;
};

/** Mail is sent after the write and never fails the reply; scripts and suites wait on it. */
const inFlight = new Set<Promise<void>>();
export async function flushSupportMail(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

function emailMember(row: StaffRequestRow, reply: string, resolved: boolean) {
  const p = (async () => {
    try {
      if (!row.member.email) return;
      const rendered = renderSupportReplyEmail({
        name: row.member.name,
        reference: supportReference(row.request.number),
        subject: row.request.subject,
        reply,
        link: memberLink(row.request, row.business.publicId),
        resolved,
      });
      await resolveMailer(null).send({
        to: row.member.email,
        from: config.MAIL_FROM,
        fromName: accountBrand().name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    } catch (e) {
      log.error(e, { event: "support_reply_email_failed", request: row.request.publicId });
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * A staff reply: stored, shown to the member as "Two Minute Billing support", the unread dot
 * set, and the member emailed. `resolve` also closes the request.
 */
export async function replyAsStaff(input: {
  id: string;
  body: string;
  staff: string;
  resolve?: boolean;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const body = input.body.replace(/\r\n/g, "\n").trim().slice(0, BODY_MAX);
  if (!body) throw new SupportError("Write a reply.");
  const row = await getForStaff(input.id);
  if (!row) throw new SupportError("No such request.", 404);
  await systemDb.transaction(async (tx) => {
    await tx.insert(supportMessages).values({
      publicId: publicId("srm"),
      organizationId: row.organization.id,
      requestId: row.request.id,
      authorKind: "staff",
      body,
      staffBy: input.staff,
      // Staff wrote it: there is nobody on our side to tell.
      notifiedAt: now,
    });
    await tx
      .update(supportRequests)
      .set({
        status: input.resolve ? "resolved" : "waiting",
        resolvedAt: input.resolve ? now : null,
        lastStaffReplyAt: now,
        memberUnreadAt: now,
      })
      .where(eq(supportRequests.id, row.request.id));
  });
  log.info("support reply sent", { request: row.request.publicId, staff: input.staff });
  emailMember(row, body, !!input.resolve);
}

/** Resolve or open a request again without a reply. The member sees a line in the thread. */
export async function setStatusAsStaff(input: {
  id: string;
  status: "resolved" | "open";
  staff: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const row = await getForStaff(input.id);
  if (!row) throw new SupportError("No such request.", 404);
  if (row.request.status === input.status)
    throw new SupportError(`This request is ${input.status} already.`);
  await systemDb.transaction(async (tx) => {
    await tx.insert(supportMessages).values({
      publicId: publicId("srm"),
      organizationId: row.organization.id,
      requestId: row.request.id,
      authorKind: "system",
      body:
        input.status === "resolved"
          ? "Support marked this request as resolved. Reply to open it again."
          : "Support opened this request again.",
      staffBy: input.staff,
      notifiedAt: now,
    });
    await tx
      .update(supportRequests)
      .set({ status: input.status, resolvedAt: input.status === "resolved" ? now : null })
      .where(eq(supportRequests.id, row.request.id));
  });
  log.info("support request status changed", {
    request: row.request.publicId,
    status: input.status,
    staff: input.staff,
  });
}
