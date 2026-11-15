/**
 * The MCP server (/mcp), over real HTTP against the real app.
 *
 *  - § A credentials: only a read-only `api` key; no session, no write key, mcp:use required
 *  - § B tools/list follows the key's grant
 *  - § C business pinning and the test/live partition; no cross-org reach
 *  - § D tool calls go through the routes: data, envelope, errors, guards, invisible characters
 *  - § E the official MCP SDK client, end to end
 *  - § F prompts and the business resource; the overview tools against real data
 *
 *   pnpm verify:mcp
 */
import { randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization, createApiKey, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { TOOLS } from "@/modules/assistant-tools/catalog";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");

const org = await createOrganization({ name: `MCP ${uniq}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: `MCP Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

const readKey = (await createApiKey(orgId, "test", "api", "read", "AI")).secret;
const writeKey = (await createApiKey(orgId, "test", "api", "write", "Integration")).secret;
const customersOnly = (
  await createApiKey(orgId, "test", "api", "read", "Customers", null, {
    customers: "read",
    mcp: "read",
  })
).secret;
const noMcp = (
  await createApiKey(orgId, "test", "api", "read", "No MCP", null, { customers: "read" })
).secret;

let rpcId = 0;
const rpc = (
  secret: string | null,
  method: string,
  params: Record<string, unknown> = {},
  url = `/mcp/${biz.publicId}`,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...extra,
    },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });

const init = (secret: string, url?: string) =>
  rpc(
    secret,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify", version: "1" },
    },
    url,
  );

async function toolNames(secret: string): Promise<string[]> {
  const r = await rpc(secret, "tools/list");
  return ((r.json().result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();
}

async function call(
  secret: string,
  name: string,
  args: Record<string, unknown> = {},
  url?: string,
) {
  const r = await rpc(secret, "tools/call", { name, arguments: args }, url);
  const result = r.json().result as { isError?: boolean; content: Array<{ text: string }> };
  const text = result?.content?.[0]?.text ?? "";
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* an error result is prose */
  }
  return { isError: result?.isError === true, text, body };
}

// ── § A · credentials ────────────────────────────────────────────────────────────
{
  const none = await rpc(null, "tools/list");
  ok(
    "A1 no credential → 401 with WWW-Authenticate",
    none.statusCode === 401 && !!none.headers["www-authenticate"],
  );
  const session = await rpc(null, "tools/list", {}, undefined, {
    authorization: "Bearer sess_abc",
  });
  ok("A2 a session token is not accepted", session.statusCode === 401);
  const bad = await rpc("sk_test_nope", "tools/list");
  ok("A3 an unknown key → 401", bad.statusCode === 401);
  const write = await rpc(writeKey, "tools/list");
  ok(
    "A4 a write key is refused with how to fix it",
    write.statusCode === 403 && /read-only key/.test(write.body),
  );
  const missing = await rpc(noMcp, "tools/list");
  ok("A5 a key whose map lacks mcp is refused", missing.statusCode === 403);
  const i = await init(readKey);
  const res = i.json().result;
  ok(
    "A6 a read key initializes; server names itself and gives instructions",
    i.statusCode === 200 &&
      res?.serverInfo?.name === "tmbilling" &&
      /read-only/.test(res?.instructions ?? ""),
  );
  ok("A7 the server offers tools", !!res?.capabilities?.tools);
  const get = await app.inject({ method: "GET", url: "/mcp" });
  ok("A8 GET /mcp → 405 Allow: POST", get.statusCode === 405 && get.headers.allow === "POST");
}

// ── § B · tools/list follows the grant ───────────────────────────────────────────
{
  const all = await toolNames(readKey);
  const mcpTools = TOOLS.filter((t) => !t.assistantOnly);
  ok(`B1 a read key lists every MCP tool (${mcpTools.length})`, all.length === mcpTools.length);
  ok("B1b the source search is never offered over MCP", !all.includes("search_source"));
  const limited = await toolNames(customersOnly);
  ok(
    "B2 a customers-only key lists only its tools",
    JSON.stringify(limited) ===
      JSON.stringify([
        "explain_balance",
        "find_screen",
        "get_api_reference",
        "get_customer",
        // Listed for every key, like read_api: each read it makes is checked by its route.
        "query_records",
        "read_api",
        "search_customers",
        "search_docs",
      ]),
  );
  const r = await rpc(readKey, "tools/list");
  const tools = r.json().result.tools as Array<{ annotations?: { readOnlyHint?: boolean } }>;
  ok(
    "B3 every tool is annotated read-only",
    tools.every((t) => t.annotations?.readOnlyHint === true),
  );
}

// ── data for § C/D ───────────────────────────────────────────────────────────────
const customer = await createCustomer({
  ...ctx,
  email: `mcp-${uniq}@example.com`,
  // Zero-width space and a Unicode tag character hidden in the name.
  firstName: "Lark​field",
  lastName: `Studio\u{E0041}${uniq}`,
});
await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const { subscription } = await createSubscription({
  ...ctx,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});

// ── § C · pinning and partitions ─────────────────────────────────────────────────
{
  const bare = await call(readKey, "get_business", {}, "/mcp");
  ok(
    "C1 bare /mcp works when the key reaches one business",
    !bare.isError && bare.body?.business_id === biz.publicId,
  );
  const second = await createBusiness({
    organizationId: orgId,
    name: `MCP Second ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const many = await rpc(readKey, "tools/list", {}, "/mcp");
  ok(
    "C2 bare /mcp with two businesses → 400 naming them",
    many.statusCode === 400 && many.body.includes(second.publicId),
  );
  const live = await createBusiness({
    organizationId: orgId,
    name: `MCP Live ${uniq}`,
    defaultCurrency: "USD",
    livemode: "live",
  });
  const cross = await rpc(readKey, "tools/list", {}, `/mcp/${live.publicId}`);
  ok("C3 a test key cannot pin a live business (404)", cross.statusCode === 404);
  const other = await createOrganization({ name: `MCP Other ${uniq}` });
  const otherBiz = await createBusiness({
    organizationId: other.organization.id,
    name: `MCP Other Biz ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const foreign = await rpc(readKey, "tools/list", {}, `/mcp/${otherBiz.publicId}`);
  ok("C4 another organization's business → 404", foreign.statusCode === 404);
}

// ── § D · tool calls ─────────────────────────────────────────────────────────────
{
  const found = await call(readKey, "search_customers", { query: `mcp-${uniq}` });
  const rows = (found.body?.result as { data?: Array<{ id: string }> })?.data ?? [];
  ok(
    "D1 search_customers finds the customer",
    rows.some((c) => c.id === customer.publicId),
  );
  ok(
    "D2 every result names the business and the mode",
    found.body?.business_id === biz.publicId && found.body?.mode === "test",
  );
  ok(
    "D3 invisible characters are stripped from customer-written text",
    !/[​\u{E0041}]/u.test(found.text) && found.text.includes("Larkfield"),
  );

  const overview = await call(readKey, "get_customer", { customer: customer.publicId });
  const o = overview.body?.result as Record<string, { data?: unknown[] } | { id?: string }>;
  ok(
    "D4 get_customer returns the customer and their subscription",
    (o?.customer as { id?: string })?.id === customer.publicId &&
      JSON.stringify(o?.subscriptions).includes(subscription.publicId),
  );

  const sub = await call(readKey, "get_subscription", { subscription: subscription.publicId });
  ok(
    "D5 get_subscription includes a renewal estimate",
    !sub.isError && !!(sub.body?.result as Record<string, unknown>)?.renewal_estimate,
  );

  const cancel = await call(readKey, "preview_cancellation", {
    subscription: subscription.publicId,
    options: { cancel_option: "immediately" },
  });
  ok("D6 preview_cancellation answers with a read key", !cancel.isError);
  const after = await call(readKey, "get_subscription", { subscription: subscription.publicId });
  ok(
    "D7 the preview changed nothing",
    JSON.stringify(
      (after.body?.result as { subscription?: { status?: string } })?.subscription?.status,
    ) === '"active"',
  );

  const badFilter = await call(readKey, "list_invoices", { filters: { "nonsense[is]": "x" } });
  ok(
    "D8 an unknown filter is an error result naming the problem",
    badFilter.isError && /nonsense/.test(badFilter.text),
  );

  const missing = await call(readKey, "get_invoice", { invoice: "inv_doesnotexist" });
  ok(
    "D9 a missing record is an error result, worded for the reader",
    missing.isError && /^We could not read/.test(missing.text),
  );

  const readApi = await call(readKey, "read_api", { path: "credit_notes", query: { limit: 5 } });
  ok(
    "D10 read_api reads a list",
    !readApi.isError && (readApi.body?.result as { object?: string })?.object === "list",
  );
  const pdf = await call(readKey, "read_api", { path: `invoices/inv_x/pdf` });
  ok("D11 read_api refuses documents", pdf.isError);
  const dots = await call(readKey, "read_api", { path: "../../v1/api_keys" });
  ok("D12 read_api refuses path traversal", dots.isError);
  const exp = await call(readKey, "read_api", { path: "raw_export/customers" });
  ok("D13 read_api refuses bulk export", exp.isError);
  const denied = await call(customersOnly, "read_api", { path: "invoices" });
  ok(
    "D14 read_api cannot exceed the key's grant (route refuses)",
    denied.isError && /We could not read invoices/.test(denied.text),
  );
  const unlisted = await call(customersOnly, "list_invoices", {});
  ok("D15 calling an unlisted tool fails", unlisted.isError);
}

// ── § F · prompts, the business resource, the overview tools ─────────────────────
{
  const prompts = await rpc(readKey, "prompts/list");
  const names = ((prompts.json().result?.prompts ?? []) as Array<{ name: string }>)
    .map((p) => p.name)
    .sort();
  ok(
    "F1 prompts/list offers monthly_review and failed_payment",
    JSON.stringify(names) === JSON.stringify(["failed_payment", "monthly_review"]),
  );
  const review = await rpc(readKey, "prompts/get", {
    name: "monthly_review",
    arguments: { month: "2026-02" },
  });
  const reviewText = String(review.json().result?.messages?.[0]?.content?.text ?? "");
  ok(
    "F2 monthly_review names the month's days and the tools to call",
    review.json().result?.messages?.[0]?.role === "user" &&
      reviewText.includes("2026-02-01") &&
      reviewText.includes("2026-02-28") &&
      ["explain_mrr_change", "list_invoices", "get_upcoming_charges"].every((t) =>
        reviewText.includes(t),
      ),
  );
  const badMonth = await rpc(readKey, "prompts/get", {
    name: "monthly_review",
    arguments: { month: "February" },
  });
  ok("F3 monthly_review refuses a month that is not YYYY-MM", !!badMonth.json().error);
  const failed = await rpc(readKey, "prompts/get", {
    name: "failed_payment",
    arguments: { id: "pi_XXXXXXXXXXXX01" },
  });
  ok(
    "F4 failed_payment asks for explain_payment with the payment",
    String(failed.json().result?.messages?.[0]?.content?.text ?? "").includes(
      "explain_payment with payment pi_XXXXXXXXXXXX01",
    ),
  );
  const resources = await rpc(readKey, "resources/list");
  ok(
    "F5 resources/list offers tmbilling://business",
    ((resources.json().result?.resources ?? []) as Array<{ uri: string }>).some(
      (r) => r.uri === "tmbilling://business",
    ),
  );
  const res = await rpc(readKey, "resources/read", { uri: "tmbilling://business" });
  const content = res.json().result?.contents?.[0] as { mimeType?: string; text?: string };
  ok(
    "F6 resources/read returns the business as JSON",
    content?.mimeType === "application/json" &&
      (JSON.parse(content?.text ?? "{}") as { business_id?: string }).business_id === biz.publicId,
  );
  const noSettings = await rpc(customersOnly, "resources/list");
  ok(
    "F7 a key without settings:view is offered no resource",
    ((noSettings.json().result?.resources ?? []) as unknown[]).length === 0,
  );

  const catalog = await call(readKey, "get_catalog");
  ok(
    "F8 get_catalog lists the price with its amount",
    !catalog.isError &&
      JSON.stringify((catalog.body?.result as { prices?: unknown })?.prices).includes(
        `"amount_minor":1000`,
      ),
  );
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const upcoming = await call(readKey, "get_upcoming_charges", {
    from: day(new Date()),
    to: day(new Date(Date.now() + 40 * 86_400_000)),
  });
  const up = upcoming.body?.result as {
    data?: Array<{ id: string; payer?: { pays_with?: { type?: string } } }>;
    totals?: Array<{ currency: string; amount_minor: number }>;
  };
  ok(
    "F9 get_upcoming_charges finds the renewal with its payer and total",
    !upcoming.isError &&
      up?.data?.some(
        (s) => s.id === subscription.publicId && s.payer?.pays_with?.type === "card",
      ) === true &&
      up?.totals?.some((t) => t.currency === "USD" && t.amount_minor >= 1000) === true,
  );
  const timeline = await call(readKey, "get_timeline", { record: customer.publicId });
  ok(
    "F10 get_timeline answers for a customer",
    !timeline.isError && Array.isArray((timeline.body?.result as { entries?: unknown[] })?.entries),
  );
  const queue = await call(readKey, "get_collections_queue", { days: 7 });
  ok(
    "F11 get_collections_queue answers with a total per currency",
    !queue.isError && Array.isArray((queue.body?.result as { total_due?: unknown })?.total_due),
  );
  const neither = await call(readKey, "explain_payment", {});
  ok(
    "F12 explain_payment without an invoice or a payment is an error result",
    neither.isError && /Give invoice/.test(neither.text),
  );
  const query = await call(readKey, "query_records", {
    resource: "subscriptions",
    with_payer: true,
    group_by: ["currency", "payer.pays_with.type"],
    metrics: [{ op: "sum", field: "recurring_amount_minor" }, { op: "count_distinct", field: "customer" }],
  });
  const q = query.body?.result as {
    rows_read?: number;
    complete?: boolean;
    totals?: { count?: number; sum_recurring_amount_minor?: number };
    groups?: Array<{ key: Record<string, unknown>; count: number }>;
  };
  ok(
    "F13 query_records sums every subscription and groups by currency and payment type",
    !query.isError &&
      q?.complete === true &&
      (q.rows_read ?? 0) >= 1 &&
      (q.totals?.sum_recurring_amount_minor ?? 0) >= 1000 &&
      q.groups?.some((g) => g.key.currency === "USD" && g.key["payer.pays_with.type"] === "card") === true,
  );
  const notList = await call(readKey, "query_records", { resource: `customers/${customer.publicId}` });
  ok("F14 query_records refuses a path that is not a list", notList.isError && /not a list/.test(notList.text));
}

// ── § E · the official SDK client end to end ─────────────────────────────────────
{
  // Route the client's fetch into the app, so the real transport (headers, 202s, the 405 on
  // GET) is exercised without a listening server.
  const injectFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const r = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
      url: u.pathname + u.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, String(v));
    const empty = r.statusCode === 202 || r.statusCode === 204;
    return new Response(empty ? null : r.body, { status: r.statusCode, headers });
  };
  const client = new Client({ name: "verify-mcp", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://mcp.local/mcp/${biz.publicId}`), {
      fetch: injectFetch,
      requestInit: { headers: { authorization: `Bearer ${readKey}` } },
    }),
  );
  ok(
    "E1 the SDK client connects and reads the instructions",
    /read-only/.test(client.getInstructions() ?? ""),
  );
  const { tools } = await client.listTools();
  ok(
    "E2 the SDK client lists the tools",
    tools.length === TOOLS.filter((t) => !t.assistantOnly).length,
  );
  const res = (await client.callTool({
    name: "get_customer",
    arguments: { customer: customer.publicId },
  })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  ok(
    "E3 the SDK client calls a tool and gets the customer",
    !res.isError && res.content[0]!.text.includes(customer.publicId),
  );
  await client.close();
}

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
