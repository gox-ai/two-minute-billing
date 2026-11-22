/**
 * The assistant's records: organization settings, the member's conversations and messages, and
 * the usage ledger behind the monthly cap. Every read and write is inside `withTenant`.
 */
import { notPlatformOrg } from "@/modules/tenancy/platform-org";
import { memberData, memberSteps } from "./visibility";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { decryptSecret, encryptSecret } from "@/platform/secrets";
import { config } from "@/platform/config";
import { isCloud } from "@/platform/edition";
import {
  assistantAttachments,
  assistantConversations,
  assistantMessages,
  assistantSettings,
  assistantUsage,
  businesses,
  organizations,
  users,
} from "@db/schema";
import { resolveModelCost, tokensCostFixed12 } from "@/modules/model-prices/resolve";
import { platformConfigured, type OwnKey, type Provider } from "./llm";
import {
  UNPRICED_CENTS_PER_MILLION_TOKENS,
  centsToCredits,
  fixed12ToCents,
  renewsAt,
  usedPercent,
} from "./allowance";

// ── settings ───────────────────────────────────────────────────────────────────

export interface AssistantSettingsView {
  enabled: boolean;
  own_key: { provider: Provider; model: string | null; last4: string | null } | null;
  platform_available: boolean;
  /** Billy may prepare changes the member confirms (0508). */
  actions_enabled: boolean;
  /** Also money actions, each with a second confirmation (0508). */
  money_actions_enabled: boolean;
}

export async function getSettings(organizationId: string): Promise<AssistantSettingsView> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select().from(assistantSettings).where(eq(assistantSettings.organizationId, organizationId)),
  );
  return {
    enabled: row?.enabled ?? true,
    own_key:
      row?.apiKeyEncrypted && row.provider
        ? { provider: row.provider as Provider, model: row.model, last4: row.apiKeyLast4 }
        : null,
    platform_available: platformConfigured(),
    actions_enabled: row?.actionsEnabled ?? false,
    money_actions_enabled: (row?.actionsEnabled ?? false) && (row?.moneyActionsEnabled ?? false),
  };
}

export async function ownKeyOf(organizationId: string): Promise<OwnKey | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx.select().from(assistantSettings).where(eq(assistantSettings.organizationId, organizationId)),
  );
  if (!row?.apiKeyEncrypted || !row.provider) return null;
  return {
    provider: row.provider as Provider,
    model: row.model,
    apiKey: decryptSecret(row.apiKeyEncrypted),
  };
}

export async function updateSettings(
  organizationId: string,
  patch: {
    enabled?: boolean;
    own_key?: { provider: Provider; model?: string | null; api_key: string } | null;
    actions_enabled?: boolean;
    money_actions_enabled?: boolean;
  },
): Promise<AssistantSettingsView> {
  const set: Partial<typeof assistantSettings.$inferInsert> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.actions_enabled !== undefined) set.actionsEnabled = patch.actions_enabled;
  if (patch.money_actions_enabled !== undefined)
    set.moneyActionsEnabled = patch.money_actions_enabled;
  // Money actions ride on actions: switching actions off switches them off too.
  if (patch.actions_enabled === false) set.moneyActionsEnabled = false;
  if (patch.own_key === null) {
    Object.assign(set, { provider: null, model: null, apiKeyEncrypted: null, apiKeyLast4: null });
  } else if (patch.own_key) {
    Object.assign(set, {
      provider: patch.own_key.provider,
      model: patch.own_key.model?.trim() || null,
      apiKeyEncrypted: encryptSecret(patch.own_key.api_key),
      apiKeyLast4: patch.own_key.api_key.slice(-4),
    });
  }
  await withTenant(organizationId, (tx) =>
    tx
      .insert(assistantSettings)
      .values({ organizationId, ...set })
      .onConflictDoUpdate({ target: assistantSettings.organizationId, set }),
  );
  return getSettings(organizationId);
}

// ── usage and the cap ──────────────────────────────────────────────────────────

/**
 * Platform-billed tokens an organization may use per calendar month (UTC), when account billing
 * gives no allowance (self-hosted, or Cloud without it). Null = no cap.
 */
export function monthlyCap(): number | null {
  const v = config.ASSISTANT_ORG_MONTHLY_TOKENS;
  if (v === 0) return null;
  if (v !== undefined) return v;
  return isCloud() ? 2_000_000 : null;
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Cloud: the allowance account billing wrote for the organization's plan; null = none. */
async function allowanceCents(organizationId: string): Promise<number | null> {
  if (!isCloud()) return null;
  const [o] = await withTenant(organizationId, (tx) =>
    tx
      .select({ cents: organizations.assistantAllowanceUsdCents })
      .from(organizations)
      .where(eq(organizations.id, organizationId)),
  );
  return o?.cents ?? null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function monthUsage(organizationId: string, now = new Date()) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        platform: sql<string>`coalesce(sum(${assistantUsage.inputTokens} + ${assistantUsage.outputTokens}) filter (where ${assistantUsage.billedTo} = 'platform'), 0)`,
        own: sql<string>`coalesce(sum(${assistantUsage.inputTokens} + ${assistantUsage.outputTokens}) filter (where ${assistantUsage.billedTo} = 'organization'), 0)`,
        turns: sql<string>`count(*)`,
        cost: sql<string | null>`sum(${assistantUsage.costFixed12})`,
        platformCost: sql<
          string | null
        >`sum(${assistantUsage.costFixed12}) filter (where ${assistantUsage.billedTo} = 'platform')`,
        unpriced: sql<string>`coalesce(sum(${assistantUsage.inputTokens} + ${assistantUsage.outputTokens}) filter (where ${assistantUsage.billedTo} = 'platform' and ${assistantUsage.costFixed12} is null), 0)`,
      })
      .from(assistantUsage)
      .where(
        and(
          eq(assistantUsage.organizationId, organizationId),
          gte(assistantUsage.createdAt, monthStart(now)),
        ),
      ),
  );
  const allowance = await allowanceCents(organizationId);
  // An allowance replaces the token cap.
  const cap = allowance === null ? monthlyCap() : null;
  const platform = Number(row?.platform ?? 0);
  const usedCents =
    fixed12ToCents(row?.platformCost ?? null) +
    (Number(row?.unpriced ?? 0) * UNPRICED_CENTS_PER_MILLION_TOKENS) / 1_000_000;
  return {
    month_start: monthStart(now).toISOString(),
    platform_tokens: platform,
    own_key_tokens: Number(row?.own ?? 0),
    turns: Number(row?.turns ?? 0),
    /** USD minor units × 10^12; null when no turn was priced. */
    cost_fixed12: row?.cost ?? null,
    cap_tokens: cap,
    remaining_tokens: cap === null ? null : Math.max(0, cap - platform),
    /** Cloud: this month's allowance on our model for the organization's plan. */
    allowance:
      allowance === null
        ? null
        : {
            mode: config.ASSISTANT_ALLOWANCE_MODE,
            usd_cents: allowance,
            used_usd_cents: round2(usedCents),
            /** What members see: the allowance and its use in credits. */
            credits: centsToCredits(allowance),
            used_credits: centsToCredits(usedCents),
            used_percent: usedPercent(usedCents, allowance),
            used_up: usedCents >= allowance,
            renews_at: renewsAt(now).toISOString(),
          },
  };
}

export type MonthUsage = Awaited<ReturnType<typeof monthUsage>>;

/** Questions on our model stop: the allowance is used up (enforce mode only), or the token cap. */
export function capReached(u: MonthUsage): boolean {
  if (u.allowance) return u.allowance.mode === "enforce" && u.allowance.used_up;
  return u.cap_tokens !== null && u.platform_tokens >= u.cap_tokens;
}

/** A turn on the platform key may start only below the cap; one in flight always finishes. */
export async function underCap(organizationId: string): Promise<boolean> {
  return !capReached(await monthUsage(organizationId));
}

export async function recordUsage(input: {
  organizationId: string;
  userId: string;
  conversationId: string | null;
  provider: string;
  model: string;
  billedTo: "platform" | "organization";
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await withTenant(input.organizationId, async (tx) => {
    const now = new Date();
    const price = async (tokenType: string, tokens: number) => {
      if (!tokens) return 0n;
      const hit = await resolveModelCost(
        tx,
        input.organizationId,
        { provider: input.provider, model: input.model, tokenType, currency: "USD" },
        now,
      ).catch(() => null);
      if (!hit || !("unitAmount" in hit)) return null;
      return tokensCostFixed12(tokens, hit);
    };
    const inCost = await price("input", input.inputTokens);
    const outCost = await price("output", input.outputTokens);
    await tx.insert(assistantUsage).values({
      organizationId: input.organizationId,
      userId: input.userId,
      conversationId: input.conversationId,
      provider: input.provider,
      model: input.model,
      billedTo: input.billedTo,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costFixed12: inCost === null || outCost === null ? null : String(inCost + outCost),
    });
  });
}

// ── conversations ──────────────────────────────────────────────────────────────

export type ConversationRow = typeof assistantConversations.$inferSelect;

export async function createConversation(input: {
  organizationId: string;
  businessId: string;
  userId: string;
  title: string;
}): Promise<ConversationRow> {
  const [row] = await withTenant(input.organizationId, (tx) =>
    tx
      .insert(assistantConversations)
      .values({
        publicId: publicId("acv"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        userId: input.userId,
        title: input.title.slice(0, 120) || "New conversation",
      })
      .returning(),
  );
  return row!;
}

/** The member's own conversation, or null. Another member's is never returned. */
export async function getConversation(organizationId: string, userId: string, id: string) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(assistantConversations)
      .where(
        and(eq(assistantConversations.publicId, id), eq(assistantConversations.userId, userId)),
      ),
  );
  return row ?? null;
}

// ── history: search, rename, archive, pin, share ───────────────────────────────

export const HISTORY_PAGE_MAX = 50;
const SEARCH_WORDS_MAX = 8;
const SNIPPET_MAX = 140;

/** A search is one phrase; every word must appear (in the title, or in one message). */
export function searchWords(q: string | null | undefined): string[] {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, SEARCH_WORDS_MAX);
}

const likeArg = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Message text without markdown marks, on one line. */
function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[a-z]*|[`*#>|]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Up to ~140 characters of a message around the first matched word. */
export function snippetOf(content: string, words: string[], max = SNIPPET_MAX): string {
  const text = plainText(content);
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const room = max - 2; // the two ellipses
  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(room / 4));
  start = Math.min(start, text.length - room);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < (at < 0 ? start + 20 : at)) start = space + 1;
  }
  let end = Math.min(text.length, start + room);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + room / 2) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Where the next page starts: the last row's sort keys, to the microsecond. */
export interface HistoryCursor {
  p: string | null;
  u: string;
  i: string;
}
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeHistoryCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify([c.p, c.u, c.i])).toString("base64url");
}

/** Null when the text is not a cursor this list made. */
export function decodeHistoryCursor(s: string): HistoryCursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [p, u, i] = v as unknown[];
    if (p !== null && !(typeof p === "string" && STAMP.test(p))) return null;
    if (typeof u !== "string" || !STAMP.test(u)) return null;
    if (typeof i !== "string" || !UUID.test(i)) return null;
    return { p: p as string | null, u, i };
  } catch {
    return null;
  }
}

const utcStamp = (col: unknown) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface HistoryItem {
  row: ConversationRow;
  business: string;
  /** Search only: the matching message's text, or null when the title matched. */
  snippet?: string | null;
}

/**
 * The member's conversations, pinned first (newest pin first), then by the last message.
 * With `q`, only those whose title, or one message, holds every word of it.
 */
export async function listHistory(input: {
  organizationId: string;
  userId: string;
  businessId: string | null;
  archived: boolean;
  q: string | null;
  limit: number;
  cursor: HistoryCursor | null;
}): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const c = assistantConversations;
  const words = searchWords(input.q);
  const titleAll = words.length
    ? sql.join(
        words.map((w) => sql`${c.title} ILIKE ${likeArg(w)}`),
        sql` AND `,
      )
    : null;
  const messageAll = words.length
    ? sql.join(
        words.map((w) => sql`m.content ILIKE ${likeArg(w)}`),
        sql` AND `,
      )
    : null;
  const k = input.cursor;
  const after = !k
    ? undefined
    : k.p === null
      ? sql`(${c.pinnedAt} IS NULL AND (${c.updatedAt}, ${c.id}) < (${k.u}::timestamptz, ${k.i}::uuid))`
      : sql`(${c.pinnedAt} IS NULL OR (${c.pinnedAt}, ${c.updatedAt}, ${c.id}) < (${k.p}::timestamptz, ${k.u}::timestamptz, ${k.i}::uuid))`;
  const limit = Math.min(Math.max(1, input.limit), HISTORY_PAGE_MAX);
  const rows = await withTenant(input.organizationId, (tx) =>
    tx
      .select({
        row: c,
        business: businesses.publicId,
        pk: utcStamp(c.pinnedAt) as SQL<string | null>,
        uk: utcStamp(c.updatedAt),
        titleHit: titleAll ? sql<boolean>`(${titleAll})` : sql<boolean>`false`,
        hit: messageAll
          ? sql<
              string | null
            >`(SELECT m.content FROM assistant_messages m WHERE m.conversation_id = ${c.id} AND ${messageAll} ORDER BY m.created_at DESC LIMIT 1)`
          : sql<string | null>`null`,
      })
      .from(c)
      .innerJoin(businesses, eq(businesses.id, c.businessId))
      .where(
        and(
          eq(c.organizationId, input.organizationId),
          eq(c.userId, input.userId),
          input.businessId ? eq(c.businessId, input.businessId) : undefined,
          input.archived ? isNotNull(c.archivedAt) : isNull(c.archivedAt),
          titleAll && messageAll
            ? sql`((${titleAll}) OR EXISTS (SELECT 1 FROM assistant_messages m WHERE m.conversation_id = ${c.id} AND ${messageAll}))`
            : undefined,
          after,
        ),
      )
      .orderBy(sql`${c.pinnedAt} DESC NULLS LAST`, desc(c.updatedAt), desc(c.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      row: r.row,
      business: r.business,
      ...(words.length ? { snippet: r.titleHit || !r.hit ? null : snippetOf(r.hit, words) } : {}),
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeHistoryCursor({ p: last.pk, u: last.uk, i: last.row.id })
        : null,
  };
}

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The owner renames, archives, pins or shares their own conversation; null when it is not
 * theirs. Each stamp is kept when it is already set, so a repeat changes nothing. Archiving
 * unpins; pinning brings an archived chat back. None of these moves `updated_at`.
 */
export async function updateConversation(
  organizationId: string,
  userId: string,
  id: string,
  patch: { title?: string; archived?: boolean; pinned?: boolean; shared?: boolean },
): Promise<HistoryItem | null> {
  if (patch.archived === true && patch.pinned === true)
    throw new HistoryError(
      "We could not change this conversation. An archived conversation cannot be pinned. Send archived or pinned, not both.",
    );
  const c = assistantConversations;
  const now = sql`${new Date().toISOString()}::timestamptz`;
  const keep = (col: Column) => sql`coalesce(${col}, ${now})`;
  const set: {
    title?: string;
    sharedAt?: SQL | null;
    pinnedAt?: SQL | null;
    archivedAt?: SQL | null;
  } = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.shared !== undefined) set.sharedAt = patch.shared ? keep(c.sharedAt) : null;
  if (patch.pinned !== undefined) set.pinnedAt = patch.pinned ? keep(c.pinnedAt) : null;
  if (patch.pinned === true) set.archivedAt = null;
  if (patch.archived !== undefined) set.archivedAt = patch.archived ? keep(c.archivedAt) : null;
  if (patch.archived === true) set.pinnedAt = null;
  return withTenant(organizationId, async (tx) => {
    const mine = and(eq(c.publicId, id), eq(c.userId, userId));
    if (Object.keys(set).length) await tx.update(c).set(set).where(mine);
    const [row] = await tx
      .select({ row: c, business: businesses.publicId })
      .from(c)
      .innerJoin(businesses, eq(businesses.id, c.businessId))
      .where(mine);
    return row ?? null;
  });
}

/** Back to the main list: a new message in an archived conversation. */
export async function unarchiveConversation(organizationId: string, conversationId: string) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .update(assistantConversations)
      .set({ archivedAt: null })
      .where(eq(assistantConversations.id, conversationId))
      .returning(),
  );
  return row!;
}

/**
 * A conversation its owner shared, for any member of the organization; null when it is not
 * shared or its business is not visible to them.
 */
export async function getSharedConversation(organizationId: string, id: string) {
  const c = assistantConversations;
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ row: c, business: businesses.publicId, ownerName: users.name })
      .from(c)
      .innerJoin(businesses, eq(businesses.id, c.businessId))
      .leftJoin(users, eq(users.id, c.userId))
      .where(and(eq(c.publicId, id), eq(c.organizationId, organizationId), isNotNull(c.sharedAt))),
  );
  return row ?? null;
}

/**
 * A message as another member reads it in a shared conversation. Left out: the owner's
 * screenshots, support draft, rating, follow-up chips and prepared changes, and record cards
 * from tools the reader's role cannot use.
 */
export function serializeSharedMessage(
  m: typeof assistantMessages.$inferSelect,
  readerMaySee: (tool: string) => boolean,
) {
  const {
    attachments: _attachments,
    support_draft: _supportDraft,
    suggestions: _suggestions,
    proposal: _proposal,
    ...rest
  } = serializeMessage(m) as ReturnType<typeof serializeMessage> & MessageExtras;
  return {
    ...rest,
    data: rest.data.filter((d) => !!d.name && readerMaySee(d.name)),
    feedback: null,
  };
}

export async function deleteConversation(organizationId: string, conversationId: string) {
  await withTenant(organizationId, (tx) =>
    tx.delete(assistantConversations).where(eq(assistantConversations.id, conversationId)),
  );
}

export async function listMessages(organizationId: string, conversationId: string) {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(asc(assistantMessages.createdAt)),
  );
}

export async function addMessage(input: {
  organizationId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  steps?: unknown;
  data?: unknown;
  figures?: unknown;
  page?: unknown;
  extras?: MessageExtras | null;
}) {
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(assistantMessages)
      .values({
        publicId: publicId("amsg"),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        steps: input.steps ?? null,
        data: input.data ?? null,
        figures: input.figures ?? null,
        page: input.page ?? null,
        extras: input.extras ?? null,
      })
      .returning();
    await tx
      .update(assistantConversations)
      .set({ updatedAt: new Date() })
      .where(eq(assistantConversations.id, input.conversationId));
    return row!;
  });
}

export function serializeMessage(m: typeof assistantMessages.$inferSelect) {
  return {
    id: m.publicId,
    role: m.role,
    content: m.content,
    // What the member's browser may see; the row keeps everything (visibility.ts).
    steps: memberSteps(m.steps as Array<{ name?: string | null }> | null),
    data: memberData(m.data as Array<{ name?: string | null }> | null),
    figures: m.figures ?? null,
    page: m.page ?? null,
    ...((m.extras as MessageExtras | null) ?? {}),
    feedback: m.feedback ?? null,
    created_at: m.createdAt,
  };
}

/** What a message carries besides its text (0508). */
export interface MessageExtras {
  suggestions?: string[];
  question?: unknown;
  proposal?: unknown;
  attachments?: Array<{ id: string; name: string; content_type: string; size: number }>;
  /** Cloud: a support request drafted for the member to send (0512). */
  support_draft?: unknown;
}

/** Merge into a message's extras (a proposal's status changes after the message is saved). */
export async function patchMessageExtras(
  organizationId: string,
  messagePublicId: string,
  patch: Partial<MessageExtras>,
) {
  await withTenant(organizationId, (tx) =>
    tx
      .update(assistantMessages)
      .set({
        extras: sql`coalesce(${assistantMessages.extras}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(assistantMessages.publicId, messagePublicId)),
  );
}

/** The member's display name, for the prompt; null when they set none. */
export async function memberName(userId: string): Promise<string | null> {
  const [u] = await systemDb
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name?.trim() || null;
}

// ── feedback ───────────────────────────────────────────────────────────────────

/** For the thumbs-down alert: the organization's name and the question the answer was to. */
export async function feedbackAlertFacts(
  organizationId: string,
  messagePublicId: string,
): Promise<{ organizationName: string; question: string | null } | null> {
  const rows = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`
      select o.name as org_name,
        (select u.content from assistant_messages u
          where u.conversation_id = m.conversation_id and u.role = 'user'
            and u.created_at <= m.created_at
          order by u.created_at desc limit 1) as question
      from assistant_messages m
      join organizations o on o.id = m.organization_id
      where m.public_id = ${messagePublicId} and m.organization_id = ${organizationId}`),
  )) as unknown as Array<{ org_name: string; question: string | null }>;
  const r = rows[0];
  return r ? { organizationName: r.org_name, question: r.question } : null;
}

/** The member rates an answer in one of their own conversations. False when there is none. */
export async function setFeedback(
  organizationId: string,
  userId: string,
  messagePublicId: string,
  rating: "up" | "down" | null,
  comment: string | null,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const [m] = await tx
      .select({ id: assistantMessages.id })
      .from(assistantMessages)
      .innerJoin(
        assistantConversations,
        eq(assistantConversations.id, assistantMessages.conversationId),
      )
      .where(
        and(
          eq(assistantMessages.publicId, messagePublicId),
          eq(assistantMessages.role, "assistant"),
          eq(assistantConversations.userId, userId),
        ),
      );
    if (!m) return false;
    await tx
      .update(assistantMessages)
      .set({
        feedback: rating,
        feedbackComment: rating === "down" ? comment?.trim() || null : null,
        feedbackAt: rating ? new Date() : null,
      })
      .where(eq(assistantMessages.id, m.id));
    return true;
  });
}

// ── attachments (screenshots only) ─────────────────────────────────────────────

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Attachments are deleted after this long even if the conversation is kept. */
export const ATTACHMENT_RETENTION_DAYS = 90;

export async function createAttachment(input: {
  organizationId: string;
  businessId: string;
  userId: string;
  name: string;
  contentType: (typeof ATTACHMENT_TYPES)[number];
  data: Buffer;
}) {
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(assistantAttachments)
      .values({
        publicId: publicId("att"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        userId: input.userId,
        name: input.name.slice(0, 200),
        contentType: input.contentType,
        size: input.data.length,
        data: input.data,
      })
      .returning({
        id: assistantAttachments.publicId,
        name: assistantAttachments.name,
        content_type: assistantAttachments.contentType,
        size: assistantAttachments.size,
      });
    return row!;
  });
}

/**
 * The member's own attachments for this turn: in this business, and not yet in another
 * conversation. Each is then tied to the conversation, so it is deleted with it.
 */
export async function takeAttachments(input: {
  organizationId: string;
  businessId: string;
  userId: string;
  conversationId: string;
  ids: string[];
}) {
  if (!input.ids.length) return [];
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(assistantAttachments)
      .where(
        and(
          inArray(assistantAttachments.publicId, input.ids),
          eq(assistantAttachments.businessId, input.businessId),
          eq(assistantAttachments.userId, input.userId),
          or(
            isNull(assistantAttachments.conversationId),
            eq(assistantAttachments.conversationId, input.conversationId),
          ),
        ),
      );
    if (rows.length) {
      await tx
        .update(assistantAttachments)
        .set({ conversationId: input.conversationId })
        .where(
          inArray(
            assistantAttachments.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows;
  });
}

/** The member deletes one of their own attachments. False when there is none. */
export async function deleteAttachment(
  organizationId: string,
  userId: string,
  attachmentPublicId: string,
): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .delete(assistantAttachments)
      .where(
        and(
          eq(assistantAttachments.publicId, attachmentPublicId),
          eq(assistantAttachments.userId, userId),
        ),
      )
      .returning({ id: assistantAttachments.id }),
  );
  return rows.length > 0;
}

/** Delete attachments older than the retention period, in every organization. */
export async function sweepAttachments(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ATTACHMENT_RETENTION_DAYS * 86_400_000);
  const rows = await systemDb
    .delete(assistantAttachments)
    .where(
      and(
        lt(assistantAttachments.createdAt, cutoff),
        notPlatformOrg(assistantAttachments.organizationId),
      ),
    )
    .returning({ id: assistantAttachments.id });
  return rows.length;
}

export function serializeConversation(
  c: ConversationRow,
  businessPublicId?: string,
  snippet?: string | null,
) {
  return {
    id: c.publicId,
    title: c.title,
    ...(businessPublicId ? { business: businessPublicId } : {}),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    archived_at: c.archivedAt,
    pinned_at: c.pinnedAt,
    shared_at: c.sharedAt,
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

// ── per-member limits ──────────────────────────────────────────────────────────

/** Questions a member may ask: a burst window and a day. Read from the usage ledger. */
export const MEMBER_LIMITS = { burst: 30, burstWindowMs: 10 * 60_000, daily: 200 };
export function setMemberLimitsForTests(l: Partial<typeof MEMBER_LIMITS>): void {
  Object.assign(MEMBER_LIMITS, l);
}

/** Null when the member may ask; else the refusal to show. */
export async function memberLimitReached(
  organizationId: string,
  userId: string,
  now = new Date(),
): Promise<{ message: string; retryAfterSeconds: number } | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        burst: sql<string>`count(*) filter (where ${assistantUsage.createdAt} >= ${new Date(now.getTime() - MEMBER_LIMITS.burstWindowMs).toISOString()}::timestamptz)`,
        day: sql<string>`count(*)`,
        oldestInBurst: sql<
          string | null
        >`min(${assistantUsage.createdAt}) filter (where ${assistantUsage.createdAt} >= ${new Date(now.getTime() - MEMBER_LIMITS.burstWindowMs).toISOString()}::timestamptz)`,
      })
      .from(assistantUsage)
      .where(
        and(
          eq(assistantUsage.organizationId, organizationId),
          eq(assistantUsage.userId, userId),
          gte(assistantUsage.createdAt, new Date(now.getTime() - 86_400_000)),
        ),
      ),
  );
  if (Number(row?.day ?? 0) >= MEMBER_LIMITS.daily) {
    return {
      message: `You asked ${MEMBER_LIMITS.daily} questions in the last 24 hours, which is the limit. Try again later.`,
      retryAfterSeconds: 3600,
    };
  }
  if (Number(row?.burst ?? 0) >= MEMBER_LIMITS.burst) {
    const oldest = row?.oldestInBurst ? new Date(row.oldestInBurst).getTime() : now.getTime();
    const wait = Math.max(
      60,
      Math.ceil((oldest + MEMBER_LIMITS.burstWindowMs - now.getTime()) / 1000),
    );
    return {
      message: `You asked many questions in a short time. Wait ${Math.ceil(wait / 60)} minutes, then try again.`,
      retryAfterSeconds: wait,
    };
  }
  return null;
}

/** How many of a member's answers in the last 24 hours were declines. */
export async function recentDeclines(
  organizationId: string,
  userId: string,
  now = new Date(),
): Promise<number> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ n: sql<string>`count(*)` })
      .from(assistantMessages)
      .innerJoin(
        assistantConversations,
        eq(assistantMessages.conversationId, assistantConversations.id),
      )
      .where(
        and(
          eq(assistantConversations.userId, userId),
          eq(assistantMessages.role, "assistant"),
          gte(assistantMessages.createdAt, new Date(now.getTime() - 86_400_000)),
          sql`${assistantMessages.steps} @> '[{"name":"decline_request"}]'::jsonb`,
        ),
      ),
  );
  return Number(row?.n ?? 0);
}
