/**
 * The organization's sidebar logo (0322): `PATCH /v1/organization { icon_url }`, read back
 * through `/v1/me`, cleared with null, and the upload route's
 * refusals. No upload here ever reaches a bucket: every case is refused before the write.
 *
 *   pnpm verify:org-icon
 */
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { isObjectStoreConfigured } from "@/platform/object-store";
import { createOrganization } from "@/modules/tenancy/service";
import { config } from "@/platform/config";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);
const j = (r: { body: string }) => JSON.parse(r.body);

const { secret } = await createOrganization({ name: "Org Icon Gate" });
let n = 0;
const H = () => ({
  authorization: `Bearer ${secret}`,
  "idempotency-key": `org-icon-${Date.now()}-${n++}`,
});
const patch = (payload: unknown) =>
  app.inject({
    method: "PATCH",
    url: "/v1/organization",
    headers: H(),
    payload: payload as object,
  });
const me = async () => j(await app.inject({ method: "GET", url: "/v1/me", headers: H() }));

const URL1 = "https://assets.example.com/org/icon-1.png";

ok("a new organization has no icon", (await me()).icon_url === null);

const set = await patch({ icon_url: URL1 });
ok("PATCH icon_url → 200", set.statusCode === 200);
ok("PATCH echoes icon_url", j(set).icon_url === URL1);
ok("/v1/me returns the saved icon_url", (await me()).icon_url === URL1);

const rename = await patch({ name: "Org Icon Gate 2" });
ok("a PATCH without icon_url leaves it alone", j(rename).icon_url === URL1);

const bad = await patch({ icon_url: "javascript:alert(1)" });
ok("a non-http(s) icon_url → 400", bad.statusCode === 400);
const ftp = await patch({ icon_url: "ftp://example.com/icon.png" });
ok("an ftp icon_url → 400", ftp.statusCode === 400);
ok("a refused PATCH stores nothing", (await me()).icon_url === URL1);

const cleared = await patch({ icon_url: null });
ok("PATCH icon_url null → 200", cleared.statusCode === 200);
ok("null clears it", j(cleared).icon_url === null && (await me()).icon_url === null);

// ── Private image targets: refused at save time, like webhook URLs ───────────
const guard = config as { WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean };
const allowPrivate = guard.WEBHOOK_ALLOW_PRIVATE_TARGETS;
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
const META = "http://169.254.169.254/latest/meta-data/logo.png";
const LOOP = "http://127.0.0.1:4000/logo.png";
const PUBLIC_IP = "https://93.184.216.34/logo.png";

const orgPriv = await patch({ icon_url: META });
ok(
  "organization icon_url on a private address → 400 invalid_request_error",
  orgPriv.statusCode === 400 &&
    j(orgPriv).error?.type === "invalid_request_error" &&
    /icon_url/.test(j(orgPriv).error?.message ?? ""),
);
ok("the refused organization icon is not stored", (await me()).icon_url === null);

const bizRes = await app.inject({
  method: "POST",
  url: "/v1/businesses",
  headers: H(),
  payload: { name: "Branding Guard", default_currency: "USD", livemode: "test" },
});
const bizPath = `/v1/businesses/${j(bizRes).id}`;
const patchBiz = (payload: object) =>
  app.inject({ method: "PATCH", url: bizPath, headers: H(), payload });
for (const [field, body] of [
  ["logo_url", { logo_url: META }],
  ["icon_url", { icon_url: LOOP }],
  ["favicon_url", { favicon_url: "http://[::1]/f.ico" }],
  ["signature image_url", { invoice_customization: { signature: { image_url: LOOP } } }],
] as const) {
  const r = await patchBiz(body);
  ok(`business ${field} on a private address → 400`, r.statusCode === 400);
}
const bizRead = j(await app.inject({ method: "GET", url: bizPath, headers: H() }));
ok("refused business URLs are not stored", bizRead.logo_url == null && bizRead.icon_url == null);
const pub = await patchBiz({ logo_url: PUBLIC_IP });
ok("a public logo_url still saves", pub.statusCode === 200 && j(pub).logo_url === PUBLIC_IP);

guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
const hatch = await patchBiz({ logo_url: LOOP });
ok("WEBHOOK_ALLOW_PRIVATE_TARGETS lets a private logo_url save", hatch.statusCode === 200);
guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = allowPrivate;

// ── Upload route: refusals only ──────────────────────────────────────────────
const upload = (payload: object) =>
  app.inject({ method: "POST", url: "/v1/organization/brand_images", headers: H(), payload });

const logo = await upload({ asset: "logo", data: Buffer.from("x").toString("base64") });
ok("the organization upload takes `icon` only → 400 for logo", logo.statusCode === 400);

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
const svgRes = await upload({ asset: "icon", data: svg });
// Unconfigured storage answers first (503); configured storage refuses the SVG (400).
const expected = isObjectStoreConfigured() ? 400 : 503;
ok(`an SVG icon → ${expected} on this deployment`, svgRes.statusCode === expected);

const anon = await app.inject({
  method: "POST",
  url: "/v1/organization/brand_images",
  payload: { asset: "icon", data: svg },
});
ok("the upload route requires authentication", anon.statusCode === 401);

await app.close();
await closeDb();

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0
    ? `\n✅ ORG-ICON: PASS — ${checks.length} checks`
    : `\n❌ ORG-ICON: FAIL — ${failed}/${checks.length} failed`,
);
process.exit(failed === 0 ? 0 : 1);
