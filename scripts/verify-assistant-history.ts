/**
 * The assistant's chat history over real HTTP: list order and cursor, search, rename, archive,
 * pin, share (read-only, same organization), and that no member reaches another's chat.
 * The model is a scripted mock: nothing here calls a provider.
 *
 *   pnpm verify:assistant-history
 */
export {};

const { randomBytes, createHash } = await import("node:crypto");
const { eq } = await import("drizzle-orm");
const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
const { buildApp } = await import("@/index");
const { closeDb, systemDb } = await import("@/platform/db");
const { assistantConversations, authTokens, users } = await import("@db/schema");
const { signup, inviteUser, acceptInvite, permissionsOf } = await import("@/modules/auth/service");
const { createRole } = await import("@/modules/auth/roles");
const { createBusiness } = await import("@/modules/tenancy/service");
const { setLlmForTests } = await import("@/modules/assistant/llm");
const { addMessage, createConversation, listMessages } =
  await import("@/modules/assistant/service");
const { pinMfaMandateOff } = await import("./lib/mfa-policy");

pinMfaMandateOff();
const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");
const PW = "Heron-Lattice-50217";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const model = new MockLanguageModelV3({
  provider: "mock",
  modelId: "mock-model",
  doStream: async () => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hello." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ] as never[]),
  }),
});
setLlmForTests((billedTo) => ({ model, provider: "openai", modelId: "mock-model", billedTo }));

// ── data ─────────────────────────────────────────────────────────────────────────
const owner = await signup({
  email: `hist-${uniq}@example.com`,
  password: PW,
  name: "Owner One",
  organizationName: `History ${uniq}`,
});
const orgId = owner.user.organizationId;
const ownerCookie = `tmb_session=${owner.token}`;
const [ownerRow] = await systemDb
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, owner.user.email));
const ownerId = ownerRow!.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Hist Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const biz2 = await createBusiness({
  organizationId: orgId,
  name: `Hist Biz Two ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});

// A member who may use the assistant and see customers, not invoices.
const role = await createRole(
  orgId,
  { email: owner.user.email, permissions: permissionsOf(owner.user) },
  {
    name: `Hist reader ${uniq}`,
    permissions: ["customers:view", "assistant:view", "assistant:use"],
  },
);
const invited = await inviteUser({
  organizationId: orgId,
  email: `hist-reader-${uniq}@example.com`,
  role: role.row.publicId,
});
const tok = `invt_${randomBytes(32).toString("base64url")}`;
await systemDb.insert(authTokens).values({
  userId: invited.userId,
  tokenHash: createHash("sha256").update(tok).digest("hex"),
  purpose: "invite",
  expiresAt: new Date(Date.now() + 3600_000),
});
const readerCookie = `tmb_session=${(await acceptInvite(tok, PW)).token}`;

const outsider = await signup({
  email: `hist-out-${uniq}@example.com`,
  password: PW,
  organizationName: `History Out ${uniq}`,
});
const outsiderCookie = `tmb_session=${outsider.token}`;

const req = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { cookie, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

type Conv = {
  id: string;
  title: string;
  business: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  pinned_at: string | null;
  shared_at: string | null;
  snippet?: string | null;
};
const list = async (cookie: string, query = "") =>
  (
    await req("GET", `/auth/assistant/conversations?business=${biz.publicId}${query}`, cookie)
  ).json<{
    data: Conv[];
    has_more: boolean;
    next_cursor: string | null;
  }>();

const make = async (title: string, messages: string[], userId = ownerId, businessId = biz.id) => {
  const c = await createConversation({ organizationId: orgId, businessId, userId, title });
  for (const [i, content] of messages.entries())
    await addMessage({
      organizationId: orgId,
      conversationId: c.id,
      role: i % 2 ? "assistant" : "user",
      content,
    });
  return c.publicId;
};

const LONG =
  "Here is what changed this month. ".repeat(6) +
  "The **Harbour** plan moved three customers to annual billing after the renewal. " +
  "After that the totals settled and nothing else moved for the rest of the period.";

// Oldest first: the list is newest first.
const c1 = await make("Refund question", ["How do refunds work?", "Refunds go back to the card."]);
const c2 = await make("Plan review", ["Which plans changed?", LONG]);
const c3 = await make("Harbour annual pricing", ["Price of the yearly plan?", "It is 120."]);
const c4 = await make("Split words", ["only harbour here", "only annual here"]);
const c5 = await make("Percent sign", ["discount is 50 off"]);
const readerConv = await make("Harbour annual for the reader", ["harbour annual"], invited.userId);
const otherBiz = await make("Harbour annual elsewhere", ["harbour annual"], ownerId, biz2.id);

// ── § L · the list ───────────────────────────────────────────────────────────────
const l0 = await list(ownerCookie);
const ids0 = l0.data.map((c) => c.id);
ok(
  "L1 newest activity first, in this business only",
  JSON.stringify(ids0) === JSON.stringify([c5, c4, c3, c2, c1]),
);
const first = l0.data[0]!;
ok(
  "L2 each conversation carries business and the three stamps",
  first.business === biz.publicId &&
    first.archived_at === null &&
    first.pinned_at === null &&
    first.shared_at === null &&
    !("snippet" in first) &&
    l0.has_more === false &&
    l0.next_cursor === null,
);
ok("L3 another member's conversation is not listed", !ids0.includes(readerConv));

// Pin c2, then c4: the newest pin first, then the rest by activity.
await req("PATCH", `/auth/assistant/conversations/${c2}`, ownerCookie, { pinned: true });
const pin4 = await req("PATCH", `/auth/assistant/conversations/${c4}`, ownerCookie, {
  pinned: true,
});
const l1 = await list(ownerCookie);
ok(
  "L4 pinned first (newest pin first), then by activity",
  pin4.statusCode === 200 &&
    JSON.stringify(l1.data.map((c) => c.id)) === JSON.stringify([c4, c2, c5, c3, c1]),
);
const pinnedAt4 = pin4.json<Conv>().pinned_at;
const again = (
  await req("PATCH", `/auth/assistant/conversations/${c4}`, ownerCookie, { pinned: true })
).json<Conv>();
ok("L5 pinning again keeps the first pin time", again.pinned_at === pinnedAt4);

// Walk the list two at a time: the same order, nothing twice, nothing lost.
const walked: string[] = [];
let cursor: string | null = null;
let pages = 0;
do {
  const page = await list(
    ownerCookie,
    `&limit=2${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
  );
  walked.push(...page.data.map((c) => c.id));
  cursor = page.next_cursor;
  ok(`L6.${++pages} has_more matches next_cursor`, page.has_more === (cursor !== null));
} while (cursor && pages < 10);
ok(
  "L7 the cursor walks the pinned-then-activity order exactly",
  JSON.stringify(walked) === JSON.stringify([c4, c2, c5, c3, c1]) && pages === 3,
);
const badCursor = await req(
  "GET",
  `/auth/assistant/conversations?business=${biz.publicId}&starting_after=nonsense`,
  ownerCookie,
);
ok("L8 a cursor the list did not make → 400", badCursor.statusCode === 400);
const badLimit = await req(
  "GET",
  `/auth/assistant/conversations?business=${biz.publicId}&limit=51`,
  ownerCookie,
);
const unknownQ = await req(
  "GET",
  `/auth/assistant/conversations?business=${biz.publicId}&sort=asc`,
  ownerCookie,
);
ok(
  "L9 limit above 50 and an unknown query key → 400",
  badLimit.statusCode === 400 && unknownQ.statusCode === 400,
);

// ── § R · rename ─────────────────────────────────────────────────────────────────
const before1 = l1.data.find((c) => c.id === c1)!;
const ren = await req("PATCH", `/auth/assistant/conversations/${c1}`, ownerCookie, {
  title: "  Refunds and cards  ",
});
const renamed = ren.json<Conv>();
ok(
  "R1 rename trims the title and keeps updated_at",
  ren.statusCode === 200 &&
    renamed.title === "Refunds and cards" &&
    renamed.updated_at === before1.updated_at,
);
const l2 = await list(ownerCookie);
ok(
  "R2 a rename does not reorder the list",
  JSON.stringify(l2.data.map((c) => c.id)) === JSON.stringify(l1.data.map((c) => c.id)),
);
const blank = await req("PATCH", `/auth/assistant/conversations/${c1}`, ownerCookie, {
  title: "   ",
});
const long = await req("PATCH", `/auth/assistant/conversations/${c1}`, ownerCookie, {
  title: "x".repeat(121),
});
const extra = await req("PATCH", `/auth/assistant/conversations/${c1}`, ownerCookie, {
  title: "Fine",
  colour: "red",
});
ok(
  "R3 blank title, 121 characters and an unknown key → 400",
  blank.statusCode === 400 &&
    long.statusCode === 400 &&
    extra.statusCode === 400 &&
    /Unknown parameter: colour/.test(extra.body),
);

// ── § A · archive ────────────────────────────────────────────────────────────────
const arch = await req("PATCH", `/auth/assistant/conversations/${c2}`, ownerCookie, {
  archived: true,
});
const archived = arch.json<Conv>();
ok(
  "A1 archiving a pinned conversation unpins it",
  arch.statusCode === 200 && !!archived.archived_at && archived.pinned_at === null,
);
const l3 = await list(ownerCookie);
const la = await list(ownerCookie, "&archived=true");
ok(
  "A2 it leaves the list and is in the archive",
  !l3.data.some((c) => c.id === c2) && la.data.map((c) => c.id).join() === c2,
);
const both = await req("PATCH", `/auth/assistant/conversations/${c3}`, ownerCookie, {
  archived: true,
  pinned: true,
});
ok("A3 archived and pinned together → 400", both.statusCode === 400);
const read2 = await req("GET", `/auth/assistant/conversations/${c2}`, ownerCookie);
ok(
  "A4 an archived conversation is still readable",
  read2.statusCode === 200 && read2.json<{ messages: unknown[] }>().messages.length === 2,
);
const cont = await req("POST", "/auth/assistant/messages", ownerCookie, {
  business: biz.publicId,
  conversation: c2,
  content: "One more question",
});
const [row2] = await systemDb
  .select()
  .from(assistantConversations)
  .where(eq(assistantConversations.publicId, c2));
ok(
  "A5 a new message continues it and brings it back to the list",
  cont.statusCode === 200 &&
    row2!.archivedAt === null &&
    (await listMessages(orgId, row2!.id)).length === 4 &&
    (await list(ownerCookie)).data[1]?.id === c2,
);

// ── § S · search ─────────────────────────────────────────────────────────────────
const s1 = await list(ownerCookie, "&q=HARBOUR%20Annual");
const hits = new Map(s1.data.map((c) => [c.id, c.snippet]));
ok("S1 a title match has a null snippet (case-insensitive)", hits.get(c3) === null);
const snip = hits.get(c2);
ok(
  "S2 a message match carries a plain-text snippet around the first word",
  typeof snip === "string" &&
    snip.length <= 142 &&
    /Harbour plan/.test(snip) &&
    !snip.includes("**") &&
    snip.startsWith("…"),
);
ok("S3 words split over two messages do not match", !hits.has(c4));
ok(
  "S4 never another member's conversation, never another business",
  !hits.has(readerConv) && !hits.has(otherBiz) && s1.data.length === 2,
);
const rs = await list(readerCookie, "&q=harbour%20annual");
ok(
  "S5 the other member's search finds only their own",
  rs.data.map((c) => c.id).join() === readerConv,
);
const pct = await list(ownerCookie, "&q=%25");
const under = await list(ownerCookie, "&q=_");
ok(
  "S6 % and _ are searched as text, not as patterns",
  pct.data.length === 0 && under.data.length === 0,
);
await req("PATCH", `/auth/assistant/conversations/${c1}`, ownerCookie, { archived: true });
const activeSearch = await list(ownerCookie, "&q=refunds");
const archivedSearch = await list(ownerCookie, "&q=refunds&archived=true");
ok(
  "S7 search keeps the archived filter",
  activeSearch.data.length === 0 && archivedSearch.data.map((c) => c.id).join() === c1,
);

// ── § O · only the owner writes ──────────────────────────────────────────────────
const tries = await Promise.all([
  req("PATCH", `/auth/assistant/conversations/${c3}`, readerCookie, { title: "Taken" }),
  req("PATCH", `/auth/assistant/conversations/${c3}`, readerCookie, { archived: true }),
  req("PATCH", `/auth/assistant/conversations/${c3}`, readerCookie, { pinned: true }),
  req("PATCH", `/auth/assistant/conversations/${c3}`, readerCookie, { shared: true }),
  req("DELETE", `/auth/assistant/conversations/${c3}`, readerCookie),
  req("PATCH", `/auth/assistant/conversations/${c3}`, outsiderCookie, { title: "Taken" }),
  req("DELETE", `/auth/assistant/conversations/${c3}`, outsiderCookie),
]);
const [row3] = await systemDb
  .select()
  .from(assistantConversations)
  .where(eq(assistantConversations.publicId, c3));
ok(
  "O1 another member cannot rename, archive, pin, share or delete it (404)",
  tries.every((r) => r.statusCode === 404) &&
    row3!.title === "Harbour annual pricing" &&
    !row3!.archivedAt &&
    !row3!.pinnedAt &&
    !row3!.sharedAt,
);

// ── § H · sharing ────────────────────────────────────────────────────────────────
const c3row = row3!;
await addMessage({
  organizationId: orgId,
  conversationId: c3row.id,
  role: "assistant",
  content: "Here are the records.",
  steps: [{ name: "get_invoice", label: "Read the invoice" }],
  data: [
    { name: "get_invoice", result: { id: "inv_XXXXXXXXXXXX01" } },
    { name: "get_customer", result: { id: "cus_XXXXXXXXXXXX01" } },
  ],
  extras: {
    suggestions: ["Show the next invoice"],
    attachments: [
      { id: "att_XXXXXXXXXXXX01", name: "shot.png", content_type: "image/png", size: 1 },
    ],
    support_draft: { subject: "Owner draft" },
    proposal: { id: "aact_XXXXXXXXXXXX01" },
    question: { text: "Which one?" },
  },
});
const unshared = await Promise.all([
  req("GET", `/auth/assistant/shared/${c3}`, readerCookie),
  req("GET", `/auth/assistant/shared/${c3}`, ownerCookie),
]);
ok(
  "H1 an unshared conversation is 404 on the shared route",
  unshared.every((r) => r.statusCode === 404),
);
const share = await req("PATCH", `/auth/assistant/conversations/${c3}`, ownerCookie, {
  shared: true,
});
ok("H2 the owner shares it", share.statusCode === 200 && !!share.json<Conv>().shared_at);
const seen = await req("GET", `/auth/assistant/shared/${c3}`, readerCookie);
const sv = seen.json<{
  id: string;
  title: string;
  business: string;
  owner: { name: string | null };
  shared_at: string;
  messages: Array<Record<string, any>>;
}>();
const last = sv.messages?.at(-1) ?? {};
ok(
  "H3 a member of the organization reads it, with the owner's name",
  seen.statusCode === 200 &&
    sv.id === c3 &&
    sv.business === biz.publicId &&
    sv.owner?.name === "Owner One" &&
    !!sv.shared_at &&
    sv.messages.length === 3,
);
ok(
  "H4 the owner's screenshots, draft, chips, prepared change and rating are left out",
  !("attachments" in last) &&
    !("support_draft" in last) &&
    !("suggestions" in last) &&
    !("proposal" in last) &&
    last.feedback === null &&
    last.question?.text === "Which one?",
);
ok(
  "H5 record cards only from tools the reader's role can use",
  JSON.stringify(last.data?.map((d: { name: string }) => d.name)) === '["get_customer"]',
);
const ownerView = (await req("GET", `/auth/assistant/shared/${c3}`, ownerCookie)).json<{
  messages: Array<Record<string, any>>;
}>();
ok(
  "H6 a reader with invoices:view sees the invoice card too",
  ownerView.messages.at(-1)?.data?.length === 2,
);
const outsiderSeen = await req("GET", `/auth/assistant/shared/${c3}`, outsiderCookie);
const wrongBiz = await req(
  "GET",
  `/auth/assistant/shared/${c3}?business=${biz2.publicId}`,
  readerCookie,
);
ok(
  "H7 another organization, or another business → 404",
  outsiderSeen.statusCode === 404 && wrongBiz.statusCode === 404,
);
const readerWrite = await req("POST", "/auth/assistant/messages", readerCookie, {
  business: biz.publicId,
  conversation: c3,
  content: "Can I add to this?",
});
ok(
  "H8 shared is read-only: the reader cannot add a message",
  readerWrite.statusCode === 404 && (await listMessages(orgId, c3row.id)).length === 3,
);
ok(
  "H9 the reader's own list does not show it",
  !(await list(readerCookie)).data.some((c) => c.id === c3),
);
await req("PATCH", `/auth/assistant/conversations/${c3}`, ownerCookie, { shared: false });
const afterUnshare = await req("GET", `/auth/assistant/shared/${c3}`, readerCookie);
ok("H10 after unsharing → 404", afterUnshare.statusCode === 404);

// ── § D · delete stays as it is ──────────────────────────────────────────────────
const del = await req("DELETE", `/auth/assistant/conversations/${c5}`, ownerCookie);
const gone = await req("GET", `/auth/assistant/conversations/${c5}`, ownerCookie);
ok("D1 the owner deletes their conversation", del.statusCode === 200 && gone.statusCode === 404);

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(failed ? "❌ ASSISTANT-HISTORY: FAIL" : "✅ ASSISTANT-HISTORY: PASS");
await closeDb();
process.exit(failed ? 1 : 0);
