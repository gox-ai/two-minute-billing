/**
 * Outbound webhooks must not reach our own network.
 *
 * A `developer` member types the endpoint URL and the worker POSTs to it, so without a
 * guard that URL can be loopback, RFC 1918 or cloud metadata. Proves the guard at BOTH
 * points: save (a 400 from the service and the route) and send (a row saved before the
 * guard, or whose DNS changed, is refused at connect time and the receiver never sees it).
 * Also: a 3xx is not followed, and `last_error` stores a fixed sentence, not a raw address.
 *
 * `verify-run.ts` turns the guard off for every suite; this one turns it back on.
 *
 *   pnpm verify:webhook-ssrf
 */
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { config } from "@/platform/config";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import {
  createEndpoint,
  updateEndpoint,
  testSendEndpoint,
  EndpointValidationError,
} from "@/modules/webhooks/endpoints";
import { attemptDelivery } from "@/modules/webhooks/outbox";
import { events, webhookDeliveries, webhookEndpoints } from "@db/schema";

const guard = config as { WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean };
let pass = true;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
};

// Local receiver: counts every request it gets. `/redirect` answers 302 to `/landing`.
const hits: string[] = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    hits.push(req.url ?? "");
    if (req.url === "/redirect") res.writeHead(302, { Location: "/landing" }).end();
    else res.writeHead(200).end("ok");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const local = `http://127.0.0.1:${port}`;

const org = await createOrganization({ name: "SSRF Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "SSRF Biz",
  defaultCurrency: "USD",
  livemode: "test",
});

const refusedAtSave = async (url: string) => {
  try {
    await createEndpoint({ organizationId: orgId, url, livemode: "test" });
    return false;
  } catch (e) {
    return e instanceof EndpointValidationError && /private or reserved/.test(e.message);
  }
};

// ── Save time ─────────────────────────────────────────────────────────────────
console.log("save time (guard on):");
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
for (const url of [
  `${local}/hook`,
  "http://localhost:8080/hook",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/hook",
  "http://192.168.1.1/hook",
  "http://100.64.0.1/hook",
  "http://0.0.0.0/hook",
  "http://2130706433/hook", // 127.0.0.1 as one decimal number
  "http://[::1]/hook",
  "http://[::ffff:127.0.0.1]/hook",
  "http://[fd00::1]/hook",
]) {
  ok(`createEndpoint refuses ${url}`, await refusedAtSave(url));
}
// `.test` never resolves; an unresolvable name is allowed and checked again at send time.
const publicEp = await createEndpoint({
  organizationId: orgId,
  url: "https://hooks.example.test/receive",
  livemode: "test",
});
ok("createEndpoint accepts a public URL", !!publicEp.endpoint.id);
let updateRefused = false;
try {
  await updateEndpoint(orgId, publicEp.endpoint.publicId, { url: `${local}/hook` });
} catch (e) {
  updateRefused = e instanceof EndpointValidationError;
}
ok("updateEndpoint refuses a private URL", updateRefused);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const apiPort = (app.server.address() as { port: number }).port;
const routeRes = await fetch(`http://127.0.0.1:${apiPort}/v1/webhook_endpoints`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${org.secret}`,
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/", livemode: "test" }),
});
const routeBody = (await routeRes.json()) as { error?: { message?: string } };
ok(
  "POST /v1/webhook_endpoints with a metadata URL → 400",
  routeRes.status === 400 && /private or reserved/.test(routeBody.error?.message ?? ""),
  `${routeRes.status} ${routeBody.error?.message ?? ""}`,
);
await app.close();

// ── Send time ─────────────────────────────────────────────────────────────────
// Rows saved with the guard off stand in for rows saved before it, or whose DNS changed.
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
const mk = (path: string) =>
  createEndpoint({ organizationId: orgId, url: `${local}${path}`, livemode: "test" });
const privateEp = (await mk("/private")).endpoint;
const namedEp = (
  await createEndpoint({
    organizationId: orgId,
    url: `http://localhost:${port}/named`,
    livemode: "test",
  })
).endpoint;
const redirectEp = (await mk("/redirect")).endpoint;
const controlEp = (await mk("/control")).endpoint;
const closedEp = (
  await createEndpoint({
    organizationId: orgId,
    url: "http://127.0.0.1:1/closed",
    livemode: "test",
  })
).endpoint;
// Not a delivery target here; disabled so the emit below does not queue it.
await systemDb
  .update(webhookEndpoints)
  .set({ enabled: "false" })
  .where(eq(webhookEndpoints.id, publicEp.endpoint.id));

// One event, fanned out to every enabled endpoint above.
await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "ssrf@example.com",
});

const attempt = async (ep: typeof webhookEndpoints.$inferSelect) => {
  const [d] = await systemDb
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, ep.id))
    .limit(1);
  if (!d) throw new Error(`no delivery queued for ${ep.url}`);
  const [ev] = await systemDb.select().from(events).where(eq(events.id, d.eventId)).limit(1);
  const transcript = await attemptDelivery({
    delivery: d,
    event: ev!,
    endpoint: ep,
    now: new Date(),
    timeoutMs: 5_000,
    skipOpenCircuit: false,
    capture: true,
  });
  const [row] = await systemDb
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, d.id))
    .limit(1);
  return { transcript, row: row! };
};

console.log("send time (guard on):");
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
for (const ep of [privateEp, namedEp]) {
  const { transcript, row } = await attempt(ep);
  ok(
    `a stored ${ep.url} is refused, terminally`,
    transcript.outcome === "failed" &&
      row.status === "failed" &&
      row.attempts === 1 &&
      /private or reserved/.test(row.lastError ?? ""),
    `${transcript.outcome} / ${row.status} / ${row.lastError}`,
  );
}
const probe = await testSendEndpoint(orgId, privateEp.publicId, "invoice_paid");
ok("test-send to a private URL makes no request", probe?.responseStatus === 0);
ok(
  "the receiver saw none of the refused requests",
  !hits.some((h) => h === "/private" || h === "/named"),
  JSON.stringify(hits),
);

console.log("redirects and errors (guard off, so the local receiver answers):");
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
const redirect = await attempt(redirectEp);
ok(
  "a 302 is not followed and counts as a failed attempt",
  redirect.transcript.response?.status === 302 &&
    redirect.transcript.outcome === "retrying" &&
    !hits.includes("/landing") &&
    /do not follow redirects/.test(redirect.row.lastError ?? ""),
  `${redirect.transcript.response?.status} / ${redirect.transcript.outcome} / ${redirect.row.lastError}`,
);
const closed = await attempt(closedEp);
ok(
  "a network error is stored as a fixed sentence, not the raw error",
  closed.row.lastError === "The endpoint host refused the connection",
  String(closed.row.lastError),
);
const control = await attempt(controlEp);
ok(
  "control: with the opt-out set, a local receiver is delivered to",
  control.transcript.outcome === "delivered" && hits.includes("/control"),
  control.transcript.outcome,
);

server.close();
console.log("");
console.log(pass ? "✅ WEBHOOK-SSRF: PASS" : "❌ WEBHOOK-SSRF: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
