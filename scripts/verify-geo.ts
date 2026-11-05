/**
 * Address reference data + strict validation.
 *
 * The thing being proved is that the API is now as strict as the picker. Before
 * migration 0177 the dashboard rendered a country dropdown and an inline postal
 * check in front of an endpoint whose whole address contract was a 2-character
 * country and length caps — a strict picker in front of a permissive API, which is
 * a lie the API eventually gets told. These assertions are the API side of that.
 *
 *   pnpm verify:geo
 */
import { z } from "zod";
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import { addressRefinement } from "@/api/address-validation";
import {
  allCountries,
  countryFor,
  isValidPhone,
  isValidPostal,
  loadGeoReference,
  requirePhoneE164,
  resolveE164,
  splitE164,
  subdivisionsFor,
} from "@/platform/geo";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, good: boolean) => checks.push([name, good]);

await loadGeoReference();

// ── Postal formats ───────────────────────────────────────────────────────────
const POSTAL_OK: Array<[string, string]> = [
  ["US", "94107"],
  ["US", "94107-1234"],
  ["IN", "600001"],
  ["GB", "SW1A 1AA"],
  ["GB", "sw1a1aa"],
  ["CA", "K1A 0B1"],
  ["DE", "10115"],
  ["NL", "1012 AB"],
  ["JP", "150-0001"],
  ["AU", "2000"],
];
for (const [cc, v] of POSTAL_OK) ok(`postal ${cc} "${v}" accepted`, isValidPostal(cc, v));

const POSTAL_BAD: Array<[string, string]> = [
  ["US", "hello"],
  ["US", "941"],
  ["US", "9410712345"],
  ["IN", "60000"],
  ["IN", "ABCDEF"],
  ["GB", "NOTAPOSTCODE"],
  ["CA", "12345"],
  ["DE", "1011"],
];
for (const [cc, v] of POSTAL_BAD) ok(`postal ${cc} "${v}" rejected`, !isValidPostal(cc, v));

// The anchoring bug this guards: an unanchored pattern matches any string that
// merely CONTAINS a valid code, so "94107 and some junk" would pass.
ok("postal is anchored, not a substring match", !isValidPostal("US", "94107 and some junk"));
// A country with no postal system rejects any value rather than silently storing it.
ok("AE has no postal code, so any value is rejected", !isValidPostal("AE", "00000"));
ok(
  "empty postal is always allowed (optional field)",
  isValidPostal("US", "") && isValidPostal("US", null),
);

// ── Phone ────────────────────────────────────────────────────────────────────
ok("E.164 Indian mobile accepted", isValidPhone("+919876543210"));
ok("E.164 US number accepted", isValidPhone("+14155552671"));
ok("national number accepted with a country", isValidPhone("9876543210", "IN"));
ok("formatting characters are ignored", isValidPhone("+91 98765-43210"));
ok("too short is rejected", !isValidPhone("+9112"));
ok("letters are rejected", !isValidPhone("+91ABCDEFGHIJ", "IN"));
ok("a 3-digit number is not a valid US number", !isValidPhone("123", "US"));
ok("empty phone is allowed (optional field)", isValidPhone("") && isValidPhone(null));

/**
 * A dial code identifies a PLAN, not a country: `+1` is the whole North American
 * Numbering Plan — US, Canada and ~20 Caribbean states all share it. Resolving it to
 * one arbitrary country was the bug this covers; it validated a real US number
 * against Anguilla's pattern and rejected it. A shared code is valid if the number
 * is valid for any of its members.
 */
const nanp = splitE164("+14155552671");
ok("+1 is shared by the whole NANP", (nanp?.countries.length ?? 0) > 10);
ok(
  "+1 includes both US and CA",
  !!nanp?.countries.includes("US") && !!nanp.countries.includes("CA"),
);
ok(
  "a NANP number resolves to a NANP country",
  !!nanp?.countries.includes(resolveE164("+14155552671")?.country ?? ""),
);
ok("a Trinidad number is accepted under +1", isValidPhone("+18682221234"));

const in91 = splitE164("+919876543210");
ok("+91 is IN alone", in91?.countries.length === 1 && in91.countries[0] === "IN");
ok("+91 national part strips the dial code", in91?.national === "9876543210");

/**
 * Property, not an example: whenever one dial code is a prefix of another, the longer
 * must be tried first, or the shorter silently swallows every number under it.
 */
const allDials = [
  ...new Set(
    allCountries()
      .map((c) => c.dialCode)
      .filter(Boolean),
  ),
] as string[];
let prefixOrderOk = true;
for (const a of allDials) {
  for (const b of allDials) {
    if (a !== b && b.startsWith(a)) {
      // b is longer and starts with a — a number under b must not resolve to a's group.
      const probe = splitE164(`+${b}5551234567`);
      if (probe?.dial !== b) prefixOrderOk = false;
    }
  }
}
ok("a longer dial code is never shadowed by a shorter prefix", prefixOrderOk);

ok(
  "requirePhoneE164 prefixes a national number",
  requirePhoneE164("9876543210", "IN") === "+919876543210",
);
ok(
  "requirePhoneE164 leaves an E.164 value alone",
  requirePhoneE164("+919876543210") === "+919876543210",
);
ok(
  "requirePhoneE164 rejects a national number with no country to read it against",
  (() => {
    try {
      requirePhoneE164("9876543210");
      return false;
    } catch {
      return true;
    }
  })(),
);

// ── The address refinement, through a real parse ─────────────────────────────
const addr = z
  .object({
    state: z.string().nullable().optional(),
    state_code: z.string().nullable().optional(),
    postal_code: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  })
  .superRefine(addressRefinement);

const pathOf = (r: ReturnType<typeof addr.safeParse>) =>
  r.success ? null : (r.error.issues[0]?.path.join(".") ?? null);

ok(
  "a good Indian address parses",
  addr.safeParse({ country: "IN", state_code: "TN", postal_code: "600001", phone: "+919876543210" })
    .success,
);
ok(
  "a good US address parses",
  addr.safeParse({ country: "US", state_code: "CA", postal_code: "94107" }).success,
);

const badCountry = addr.safeParse({ country: "XX" });
ok("country XX is rejected", !badCountry.success && pathOf(badCountry) === "country");

const badState = addr.safeParse({ country: "IN", state_code: "ZZ" });
ok(
  "an invented Indian state code is rejected",
  !badState.success && pathOf(badState) === "state_code",
);

/**
 * The exact bug the closed set exists for: a NAME in state_code matches no rate
 * component, so place of supply resolves to nothing and the tax silently becomes 0.
 */
const nameNotCode = addr.safeParse({ country: "US", state_code: "California" });
ok(
  "a state NAME in state_code is rejected",
  !nameNotCode.success && pathOf(nameNotCode) === "state_code",
);

const contradiction = addr.safeParse({ country: "IN", state_code: "TN", state: "Kerala" });
ok(
  "state name contradicting state_code is rejected",
  !contradiction.success && pathOf(contradiction) === "state",
);

const badPostal = addr.safeParse({ country: "US", postal_code: "nope" });
ok("a malformed US ZIP is rejected", !badPostal.success && pathOf(badPostal) === "postal_code");

const badPhone = addr.safeParse({ country: "IN", phone: "12" });
ok("a malformed phone is rejected", !badPhone.success && pathOf(badPhone) === "phone");

/**
 * Open sets stay open. GB's top-level divisions are England / Scotland / Wales /
 * Northern Ireland, but UK addresses conventionally carry a COUNTY, which is none of
 * them — so the picker is a convenience and free text still passes.
 */
ok(
  "free text survives for a non-strict country",
  addr.safeParse({ country: "GB", state_code: "Greater London" }).success,
);
// Non-ISO Indian codes still fold rather than 400.
ok(
  "non-ISO OD folds instead of failing",
  addr.safeParse({ country: "IN", state_code: "OD" }).success,
);

/**
 * Properties of the PRIMARY SOURCE (dr5hn, ODbL), which is taken as-is for every
 * country. It codes Uttarakhand as `UK` rather than as ISO does (`UT`) — convenient,
 * since the importer copies the source's `state_code` verbatim. `UT` is
 * still accepted and folds onto `UK`, so ISO-shaped input never 400s.
 */
ok("Uttarakhand is the canonical UK", addr.safeParse({ country: "IN", state_code: "UK" }).success);
ok(
  "ISO UT still resolves, folded onto UK",
  addr.safeParse({ country: "IN", state_code: "UT" }).success,
);
ok("GB collapses to its 4 top-level divisions", (subdivisionsFor("GB") ?? []).length === 4);
ok(
  "GB keeps England",
  (subdivisionsFor("GB") ?? []).some((s) => s.value === "ENG"),
);
// The source asserts a postal format for both; neither country uses postal codes.
ok(
  "AE and HK have no postal code",
  !countryFor("AE")?.hasPostalCode && !countryFor("HK")?.hasPostalCode,
);
ok("postal hints read as N/L masks", countryFor("US")?.postalHint === "NNNNN-NNNN");

// ── HTTP surface ─────────────────────────────────────────────────────────────
const app = await buildApp({ logger: false });
// `apiKey` is the key ROW; `secret` is the bearer token that actually authenticates.
const org = await createOrganization({ name: `geo-verify-${Date.now()}` });
const auth = { authorization: `Bearer ${org.secret}` };

// Public on purpose — the hosted checkout and the customer portal render the same
// address form under a buyer token, not an org API key, so gating this would leave
// those two forms with an empty country picker.
const unauth = await app.inject({ method: "GET", url: "/v1/countries" });
ok("GET /v1/countries is public", unauth.statusCode === 200);

const list = await app.inject({ method: "GET", url: "/v1/countries", headers: auth });
const listBody = list.json() as { data: Array<Record<string, unknown>> };
ok(
  "GET /v1/countries returns the full ISO 3166-1 set",
  list.statusCode === 200 && listBody.data.length === 250,
);
ok("countries are cacheable", (list.headers["cache-control"] ?? "").toString().includes("max-age"));

const india = listBody.data.find((c) => c.code === "IN");
ok("IN carries its dial code", india?.dial_code === "91");
ok("IN is labelled PIN code", india?.postal_label === "PIN code");
ok("IN is a closed subdivision set", india?.subdivision_strict === true);

const subs = await app.inject({
  method: "GET",
  url: "/v1/countries/IN/subdivisions",
  headers: auth,
});
const subsBody = subs.json() as { data: Array<{ code: string; name: string }> };
ok(
  "GET /v1/countries/IN/subdivisions returns 36",
  subs.statusCode === 200 && subsBody.data.length === 36,
);
ok(
  'subdivision codes are the SUFFIX, not "IN-TN"',
  subsBody.data.every((s) => !s.code.includes("-")),
);
ok(
  "Tamil Nadu is present as TN",
  subsBody.data.some((s) => s.code === "TN" && s.name === "Tamil Nadu"),
);
ok(
  "engine and endpoint agree on IN",
  (subdivisionsFor("IN")?.length ?? 0) === subsBody.data.length,
);

const missing = await app.inject({ method: "GET", url: "/v1/countries/ZZ", headers: auth });
ok("an unknown country 404s", missing.statusCode === 404);

const one = await app.inject({ method: "GET", url: "/v1/countries/gb", headers: auth });
ok(
  "country lookup is case-insensitive",
  one.statusCode === 200 && (one.json() as { code: string }).code === "GB",
);

ok(
  "countryFor agrees with the endpoint",
  countryFor("GB")?.regionLabel === (one.json() as { region_label: string }).region_label,
);

await app.close();

let pass = true;
console.log("");
for (const [n, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${n}`);
  if (!good) pass = false;
}
console.log(`\n${checks.length} checks`);
console.log(pass ? "✅ GEO: PASS" : "❌ GEO: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
