/**
 * `req.organization` is a WHITELIST, not the row.
 *
 * A column added to the organization serializer stays invisible there until someone copies
 * it across, and `/v1/me` then answers "not set" whatever the database holds — silently,
 * because every one of those fields is optional on the serializer's input type, so the
 * narrower object still typechecks. Three fields have been lost this way: timezone (0216),
 * legalName (0235), baseCurrency (0268).
 *
 * So: serialize a fully populated row directly, and serialize the same row through the auth
 * view. They must be identical. Anything the view drops surfaces as a null on one side.
 *
 *   pnpm verify:org-view
 */
import { authOrganizationView } from "@/platform/auth";
import { serializeOrganization } from "@/api/routes";
import { config } from "@/platform/config";

// Cloud, so the sandbox lock and read-only status below are carried, not normalised away.
(config as { TMBILLING_EDITION: string }).TMBILLING_EDITION = "cloud";

/** Every field set to something that is NOT the value a dropped field would produce. */
const ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  publicId: "org_verifyOrgView",
  name: "Org View Gate",
  isPlatform: true,
  timezone: "Asia/Kolkata",
  legalName: "Org View Gate Pvt Ltd",
  address: { line1: "1 Gate Road", country: "IN" },
  taxRegistrationNumber: "29ABCDE1234F1Z5",
  baseCurrency: "USD",
  iconUrl: "https://assets.example.com/org/icon.png",
  liveAccess: "locked",
  status: "restricted",
};

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);

const fromRow = serializeOrganization(ROW) as Record<string, unknown>;
const fromAuth = serializeOrganization(authOrganizationView(ROW)) as Record<string, unknown>;

for (const key of Object.keys(fromRow)) {
  ok(
    `the request view carries ${key}`,
    JSON.stringify(fromRow[key]) === JSON.stringify(fromAuth[key]),
  );
}

// The loop only compares what the serializer emits, so a column that reached NEITHER is
// invisible to it. Pinning the count is what forces a deliberate edit here when one is added.
ok(
  "the serializer emits exactly the fields this gate populates",
  Object.keys(fromRow).length === 11,
);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0
    ? `\n✅ ORG-VIEW: PASS — ${checks.length} checks`
    : `\n❌ ORG-VIEW: FAIL — ${failed}/${checks.length} failed`,
);
process.exit(failed === 0 ? 0 : 1);
