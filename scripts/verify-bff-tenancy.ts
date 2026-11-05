/**
 * verify:bff-tenancy — the tier ABOVE `verify:bola`.
 *
 * `verify:bola` proves the ENGINE refuses a cross-tenant id when the caller holds an API key.
 * It says nothing about the dashboard's own HTTP surface, and that surface is a different
 * animal: its route handlers take `biz` and `inv` straight out of the URL, authenticate as the
 * signed-in operator by forwarding their session cookie, and hand the pair to the API. Nothing
 * in the handler checks that the business belongs to the session's organization — by design,
 * because the API is supposed to. This suite is the assertion that it actually does.
 *
 * The failure this guards against is specific and would not show up in `verify:bola`: if the
 * BFF ever authenticated as anything org-bound other than the caller (the `0198` defect, where
 * the dashboard ran as whatever org owned the static key), then an org-B operator pasting an
 * org-A invoice URL would be served org-A's invoice, rendered, with the API none the wiser
 * because the credential it saw was legitimate.
 *
 * ── WHY THIS IS NOT IN `verify:all` ─────────────────────────────────────────────
 * It needs a RUNNING dashboard (Next, :4400) as well as the API, and no other suite does —
 * `verify-all.sh` boots neither. Rather than let it skip silently when the dashboard is down
 * (a false clean, and the worst outcome for a security gate), it REFUSES to run and says so.
 * It is listed in `verify-all.sh`'s excluded-suites header alongside the other suites that
 * need something the script cannot start itself.
 *
 *   API_URL=http://localhost:4300 DASHBOARD_URL=http://localhost:4400 pnpm verify:bff-tenancy
 *
 * ── THE TRAP THIS SUITE IS BUILT TO AVOID ───────────────────────────────────────
 * Every cross-tenant assertion here is paired with a POSITIVE CONTROL: the same URL, with the
 * OWNING org's session, must succeed and must contain the fixture data. Without that, a route
 * that 404s for everyone — a typo in the path, a renamed segment, a handler that throws — reads
 * as perfect tenant isolation. That is exactly how a §R block in this project once nearly passed
 * for the wrong reason.
 */
import { randomBytes } from "node:crypto";
import { closeDb } from "@/platform/db";
import { signup } from "@/modules/auth/service";
import { Tmbilling } from "../sdk/index";
import { enrolAndSignIn } from "./lib/mfa-policy";

// This suite drives a RUNNING server over HTTP, so `pinMfaMandateOff()` would be a no-op here —
// the MFA policy is read by the server's process, not this one. The fixture operators COMPLY
// with the mandate instead (see scripts/lib/mfa-policy.ts), which also makes the suite
// independent of whether the deployment mandates MFA at all.

const API = process.env.API_URL ?? process.env.TMBILLING_API_URL ?? "http://localhost:4300";
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:4400";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

const uniq = randomBytes(4).toString("hex");

/** Both halves must be up. A skip here would be indistinguishable from a pass. */
for (const [label, url] of [
  ["API", `${API}/health`],
  ["dashboard", `${DASH}/login`],
] as const) {
  const reachable = await fetch(url)
    .then((r) => r.status < 500)
    .catch(() => false);
  if (!reachable) {
    console.error(
      `\n❌ BFF TENANCY: cannot run — the ${label} is not answering at ${url}.\n` +
        `   This suite asserts cross-tenant refusal on the dashboard's own HTTP surface, so it\n` +
        `   needs both halves running. It fails rather than skipping, because a skipped\n` +
        `   security gate reads exactly like a passing one.\n`,
    );
    await closeDb();
    process.exit(1);
  }
}

const PASSWORD = "Sparrow-Lantern-9134";

/** One organization, with a signed-in operator and an invoice worth stealing. */
async function tenant(label: string) {
  const email = `bff-${label}-${uniq}@repro.dev`;
  const created = await signup({
    email,
    password: PASSWORD,
    name: `BFF ${label}`,
    organizationName: `BFF Tenancy ${label} ${uniq}`,
  });
  // Fixtures go through the API so RLS applies to their creation too, rather than being
  // inserted underneath it.
  const sdk = new Tmbilling({ apiKey: created.dashboardKeySecret, baseUrl: API });
  const biz = await sdk.businesses.create({
    name: `${label}-biz-${uniq}`,
    default_currency: "USD",
    livemode: "test",
  });
  const customer = await sdk.customers.create(biz.id, {
    email: `buyer-${label}-${uniq}@acme.test`,
    first_name: `Buyer${label}`,
    last_name: uniq.toUpperCase(),
  });
  const invoice = await sdk.invoices.create(biz.id, {
    customer: customer.id,
    lines: [{ description: `BFF fixture ${label}`, amount_minor: 5000, quantity: 1 }],
  });
  // Compliant with the MFA mandate whether or not this deployment enables it — see
  // scripts/lib/mfa-policy.ts for why suppression cannot work across an HTTP boundary.
  const { token } = await enrolAndSignIn({
    userId: created.user.userId,
    email,
    password: PASSWORD,
  });
  return { email, biz, customer, invoice, session: token };
}

const A = await tenant("A");
const B = await tenant("B");

/** Raw fetch: the assertion is the status code AND the body, so nothing may wrap either. */
async function asOperator(session: string, path: string) {
  const res = await fetch(`${DASH}${path}`, {
    headers: { cookie: `tmb_session=${session}` },
    redirect: "manual",
  });
  const buf = await res.arrayBuffer();
  return { status: res.status, body: Buffer.from(buf).toString("latin1") };
}

/**
 * A refusal is anything that is not a 2xx. A 3xx counts: the dashboard answers an
 * unauthorised operator by redirecting to /login, which is a refusal, not a leak.
 */
const refused = (status: number) => status < 200 || status >= 300;

/**
 * The identifiers that must never appear in a response served to the other tenant.
 *
 * All four are globally unique, which is the property that matters — a per-business value like
 * the invoice NUMBER would collide across tenants and quietly turn every leak assertion into a
 * coin flip. The invoice id and business id are here for the JSON surfaces; the rendered invoice
 * document happens to carry the CUSTOMER id and email rather than the invoice id, which is why
 * dropping either of those would blind § A without failing anything.
 */
const secretsOf = (t: typeof A) =>
  [t.invoice.id, t.customer.id, t.customer.email ?? "", t.biz.id].filter(Boolean);

function leaks(body: string, t: typeof A): string | undefined {
  return secretsOf(t).find((s) => body.includes(s));
}

/**
 * `leaks`, minus the caller's own request path. A refusal that redirects to
 * `/login?redirectTo=<path>` echoes the ids the caller already sent; only an id found
 * ANYWHERE ELSE in the body is disclosure.
 */
function leaksBeyondEcho(body: string, t: typeof A, path: string): string | undefined {
  const stripped = [path, encodeURIComponent(path)].reduce((b, p) => b.split(p).join(""), body);
  return leaks(stripped, t);
}

// ── § A · the invoice HTML and PDF proxies ───────────────────────────────────────
//
// The two routes named in the plan. They are the highest-value target on this surface: both
// render a complete invoice — the buyer's name, address, line items and totals — as a document,
// so a leak here is not an id but the document itself.
{
  for (const kind of ["html", "pdf"] as const) {
    const path = `/businesses/${A.biz.id}/invoices/${A.invoice.id}/${kind}`;

    // Positive control FIRST. If A cannot fetch its own invoice, every refusal below is
    // meaningless and this suite would otherwise report perfect isolation.
    const mine = await asOperator(A.session, path);
    ok(
      `§A ${kind}: the OWNING operator gets their invoice`,
      mine.status === 200,
      `status ${mine.status}`,
    );
    // The control has one job: prove this URL really serves the owner a document, so that a
    // refusal below means "refused" and not "this route 404s for everybody". The two formats
    // need different evidence, and BOTH obvious choices are wrong:
    //
    //   - The invoice ID is not in the rendered HTML at all — the document shows the invoice
    //     NUMBER. Matching on the number instead would be worse than useless: numbering is
    //     per-business, so A's first invoice and B's first invoice are both `INV-1`, and a
    //     control keyed on it would pass while proving nothing. The customer id IS rendered
    //     and IS globally unique, so that is what both this control and `leaks()` key on.
    //   - A PDF's content streams are COMPRESSED, so no fixture string is findable as text in
    //     a CORRECT response. Asserting one were there would mean weakening the check until a
    //     working product looked like it was working.
    ok(
      `§A ${kind}: …and the response really is A's invoice document`,
      kind === "html"
        ? mine.body.includes(A.customer.id)
        : mine.body.startsWith("%PDF-") && mine.body.length > 1000,
      kind === "html"
        ? "positive control found no fixture data — the assertions below prove nothing"
        : `positive control got ${mine.body.length} bytes starting ${JSON.stringify(mine.body.slice(0, 8))}`,
    );

    // The attack: org B's operator, org A's URL.
    const theirs = await asOperator(B.session, path);
    ok(
      `§A ${kind}: an org-B session is REFUSED org-A's invoice`,
      refused(theirs.status),
      `status ${theirs.status}`,
    );
    // WHICH refusal matters. A 3xx would mean B never got past `requirePermission('ops')` and
    // this suite would be proving permissions, not tenancy — the same class of mistake as a
    // route that 404s for everyone. B is an org owner and DOES hold `ops`, so the only correct
    // answer is the API's own 404 arriving through the proxy: B reached the engine and the
    // engine refused on organization scope. Measured: `Failed to render invoice (404)`.
    ok(
      `§A ${kind}: …refused by the ENGINE on tenancy, not by a permission redirect`,
      theirs.status === 404,
      `expected the API's 404 through the proxy, got ${theirs.status}`,
    );
    const leaked = leaks(theirs.body, A);
    ok(
      `§A ${kind}: …and the refusal leaks none of org-A's identifiers`,
      leaked === undefined,
      leaked ?? "",
    );
  }

  // A business B owns, with an invoice id belonging to A: the other half of the id-swap shape
  // `verify:bola` runs against the engine, aimed at the BFF instead.
  const swapped = await asOperator(
    B.session,
    `/businesses/${B.biz.id}/invoices/${A.invoice.id}/html`,
  );
  ok(
    "§A id-swap: B's own business + A's invoice id is refused",
    refused(swapped.status),
    `status ${swapped.status}`,
  );
  const swapLeak = leaks(swapped.body, A);
  ok("§A id-swap: …and leaks nothing of A", swapLeak === undefined, swapLeak ?? "");
}

// ── § B · /api/lists/[entity], which takes `biz` as a QUERY PARAMETER ────────────
//
// Not in the plan's list, and a better target than the invoice routes: the business id arrives
// as `?biz=`, which is easier to tamper with than a path segment and feeds a fetcher per entity.
// One handler covers a dozen resources, so a single missing scope check here is a dozen leaks.
{
  for (const entity of ["customers", "invoices", "subscriptions"]) {
    const path = `/api/lists/${entity}?biz=${A.biz.id}&limit=20`;

    const mine = await asOperator(A.session, path);
    ok(
      `§B ${entity}: the owning operator gets their list`,
      mine.status === 200,
      `status ${mine.status}`,
    );

    const theirs = await asOperator(B.session, path);
    // Either shape is acceptable — refused outright, or answered with nothing of A's. What is
    // NOT acceptable is 200 with A's rows in it.
    const leaked = leaks(theirs.body, A);
    ok(
      `§B ${entity}: an org-B session gets none of org-A's rows`,
      refused(theirs.status) || leaked === undefined,
      `status ${theirs.status}${leaked ? ` leaked ${leaked}` : ""}`,
    );
  }

  // The positive control for the leak detector itself: A's own customers list must contain the
  // very string §B searches for. Without this, `leaks()` could be matching nothing at all and
  // every §B assertion would pass vacuously.
  const control = await asOperator(A.session, `/api/lists/customers?biz=${A.biz.id}&limit=20`);
  ok(
    "§B the leak detector is aimed at a string that really appears",
    leaks(control.body, A) !== undefined,
    "A's own customers list did not contain A's customer id or email",
  );
}

// ── § C · /api/search, same tampering shape, different handler ───────────────────
{
  const q = A.customer.last_name ?? uniq.toUpperCase();
  const path = `/api/search?biz=${A.biz.id}&q=${encodeURIComponent(String(q))}`;

  const mine = await asOperator(A.session, path);
  ok(
    "§C the owning operator can search their own business",
    mine.status === 200,
    `status ${mine.status}`,
  );

  const theirs = await asOperator(B.session, path);
  const leaked = leaks(theirs.body, A);
  ok(
    "§C an org-B session searching org-A's business finds nothing of A's",
    refused(theirs.status) || leaked === undefined,
    `status ${theirs.status}${leaked ? ` leaked ${leaked}` : ""}`,
  );
}

// ── § D · no session at all ──────────────────────────────────────────────────────
//
// The baseline. A stranger with the URL — which is how an invoice link gets forwarded in an
// email thread — must get nothing.
{
  const htmlPath = `/businesses/${A.biz.id}/invoices/${A.invoice.id}/html`;
  const res = await fetch(`${DASH}${htmlPath}`, { redirect: "manual" });
  const body = await res.text();
  ok("§D an anonymous request is refused", refused(res.status), `status ${res.status}`);
  const anonLeak = leaksBeyondEcho(body, A, htmlPath);
  ok("§D …and leaks nothing", anonLeak === undefined, anonLeak ?? "");

  const pdfPath = `/businesses/${A.biz.id}/invoices/${A.invoice.id}/pdf`;
  const forged = await asOperator("sess_not_a_real_session", pdfPath);
  ok("§D a forged session cookie is refused", refused(forged.status), `status ${forged.status}`);
  const forgedLeak = leaksBeyondEcho(forged.body, A, pdfPath);
  ok("§D …and leaks nothing", forgedLeak === undefined, forgedLeak ?? "");

  // Positive control: the echo strip must not blind the detector to a real disclosure.
  ok(
    "§D the echo strip still catches an id outside the echoed path",
    leaksBeyondEcho(`/login?redirectTo=${htmlPath} ${A.customer.id}`, A, htmlPath) !== undefined,
  );
}

// ── report ──────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ BFF TENANCY: PASS (${checks.length} checks)`
    : `\n❌ BFF TENANCY: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
