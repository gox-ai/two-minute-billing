/**
 * Metadata key rules (0332) — customer and subscription `metadata` checked against a business's
 * rules on every write.
 *
 * Proves: rule CRUD and config refusals over HTTP; every API writer (customer create/update,
 * subscription create, settings, /change, update_for_items) refuses a bad key with a 400 that
 * names it (`param: "metadata"`) and stores nothing; an old record still updates when its
 * non-conforming key is sent back unchanged; every path optional; strict; checkout mint checks types
 * only; the importer and internal writers bypass; isolation across businesses and organizations;
 * idempotent rule creation.
 *
 *   pnpm verify:metadata-rules
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { metadataKeyRules, subscriptionItems, subscriptions } from "@db/schema";
import { clearObservedCache } from "@/modules/metadata-rules/observed";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, pass: boolean, detail?: string) => checks.push([name, pass, detail]);
const j = JSON.stringify;

const org = await createOrganization({ name: "Metadata Rules Org" });
const orgId = org.organization.id;
const other = await createOrganization({ name: "Metadata Rules Other Org" });
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
const { secret: otherSecret } = await createApiKey(other.organization.id, "test");
let keyN = 0;
const call = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  opts: { key?: string; idem?: string } = {},
) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${opts.key ?? secret}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "idempotency-key": opts.idem ?? `mdr-${keyN++}` }),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: res.statusCode, body: res.json() as any };
};
const refusedOn = (r: { status: number; body: any }, key: string) =>
  r.status === 400 &&
  r.body?.error?.param === "metadata" &&
  String(r.body?.error?.message).includes(`"${key}"`);

const biz = await createBusiness({
  organizationId: orgId,
  name: "Rules Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const bizB = await createBusiness({
  organizationId: orgId,
  name: "No Rules Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const B = `/v1/businesses/${biz.publicId}`;
const BB = `/v1/businesses/${bizB.publicId}`;

// Created BEFORE any rule exists, with a value the later rule refuses.
const legacy = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "legacy@example.com",
  metadata: { tier: "bronze", note: "old" },
});

// ── § A · rule CRUD and config refusals ─────────────────────────────────────────
const idem = "mdr-create-tier";
const tier = await call(
  "POST",
  `${B}/metadata_key_rules`,
  { entity_type: "customer", key: "tier", data_type: "enum", enum_options: ["gold", "silver"] },
  { idem },
);
check(
  "§A create rule → 201 mkr_ id",
  tier.status === 201 && /^mkr_/.test(tier.body.id),
  j(tier.body),
);
const replay = await call(
  "POST",
  `${B}/metadata_key_rules`,
  { entity_type: "customer", key: "tier", data_type: "enum", enum_options: ["gold", "silver"] },
  { idem },
);
const tierRows = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(metadataKeyRules)
    .where(and(eq(metadataKeyRules.businessId, biz.id), eq(metadataKeyRules.key, "tier"))),
);
check(
  "§A same Idempotency-Key replays: same id, one row",
  replay.body.id === tier.body.id && tierRows.length === 1,
  j(replay.body),
);
const dup = await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "customer",
  key: "tier",
  data_type: "string",
});
check(
  "§A duplicate key → 400 param key",
  dup.status === 400 && dup.body.error.param === "key",
  j(dup.body),
);
const badPattern = await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "customer",
  key: "code",
  data_type: "string",
  pattern: "(a+)+",
});
check(
  "§A slow pattern → 400 param pattern",
  badPattern.status === 400 && badPattern.body.error.param === "pattern",
  j(badPattern.body),
);
const patternOnNumber = await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "customer",
  key: "seats",
  data_type: "number",
  pattern: "\\d+",
});
check("§A pattern on a number rule → 400", patternOnNumber.status === 400, j(patternOnNumber.body));
const crm = await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "customer",
  key: "crm_id",
  data_type: "string",
  pattern: "A-\\d{4}",
  description: "The CRM account id.",
});
check(
  "§A pattern rule created",
  crm.status === 201 && crm.body.pattern === "A-\\d{4}" && !("required" in crm.body),
  j(crm.body),
);
const withRequired = await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "customer",
  key: "other",
  data_type: "string",
  required: true,
});
check("§A `required` is not a rule field (400)", withRequired.status === 400, j(withRequired.body));
const list = await call("GET", `${B}/metadata_key_rules?entity_type=customer`);
check(
  "§A list returns the 2 customer rules",
  list.status === 200 && list.body.data.length === 2,
  j(list.body),
);
const patched = await call("PATCH", `${B}/metadata_key_rules/${tier.body.id}`, {
  enum_options: ["gold", "silver", "platinum"],
});
check(
  "§A patch enum_options",
  patched.status === 200 && patched.body.enum_options.length === 3,
  j(patched.body),
);
const settings0 = await call("GET", `${B}/metadata_rule_settings`);
check(
  "§A settings default: validation off, strict off",
  settings0.status === 200 &&
    settings0.body.customer.metadata_validation === "off" &&
    settings0.body.customer.strict === false,
  j(settings0.body),
);

// ── § S · the validation switch ─────────────────────────────────────────────────
// Rules exist (tier, crm_id) but validation is off: writes behave as they did before rules.
const strictWhileOff = await call("PATCH", `${B}/metadata_rule_settings`, {
  customer: { strict: true },
});
check(
  "§S strict can be set while validation is off",
  strictWhileOff.status === 200 && strictWhileOff.body.customer.strict === true,
  j(strictWhileOff.body),
);
const offWrite = await call("POST", `${B}/customers`, {
  email: "s1@example.com",
  metadata: { tier: "copper", unknown_key: 1 },
});
check(
  "§S validation off: a write that breaks rules (and strict) succeeds",
  offWrite.status === 201,
  j(offWrite.body),
);
const emptySettings = await call("PATCH", `${B}/metadata_rule_settings`, { customer: {} });
check("§S an empty entity patch is refused", emptySettings.status === 400, j(emptySettings.body));
const onAgain = await call("PATCH", `${B}/metadata_rule_settings`, {
  customer: { metadata_validation: "on", strict: false },
  subscription: { metadata_validation: "on" },
});
check(
  "§S turn validation on for both entities",
  onAgain.status === 200 &&
    onAgain.body.customer.metadata_validation === "on" &&
    onAgain.body.subscription.metadata_validation === "on",
  j(onAgain.body),
);
const onWrite = await call("POST", `${B}/customers`, {
  email: "s2@example.com",
  metadata: { tier: "copper", crm_id: "A-1000" },
});
check(
  "§S validation on: the same kind of write gets 400",
  refusedOn(onWrite, "tier"),
  j(onWrite.body),
);

// ── § B · customer create ───────────────────────────────────────────────────────
const badCreate = await call("POST", `${B}/customers`, {
  email: "b1@example.com",
  metadata: { tier: "copper", crm_id: "A-1000" },
});
check(
  "§B create with a bad enum → 400 naming tier",
  refusedOn(badCreate, "tier"),
  j(badCreate.body),
);
const withoutKey = await call("POST", `${B}/customers`, {
  email: "b2@example.com",
  metadata: { tier: "gold" },
});
check(
  "§B validation on, rule exists, key absent → 201 (every path is optional)",
  withoutKey.status === 201,
  j(withoutKey.body),
);
const noMetadata = await call("POST", `${B}/customers`, { email: "b3@example.com" });
check("§B create with no metadata at all → 201", noMetadata.status === 201, j(noMetadata.body));
const nullValue = await call("POST", `${B}/customers`, {
  email: "b6@example.com",
  metadata: { crm_id: null },
});
check("§B a null value is not checked → 201", nullValue.status === 201, j(nullValue.body));
const badPatternValue = await call("POST", `${B}/customers`, {
  email: "b4@example.com",
  metadata: { crm_id: "B-1" },
});
check(
  "§B value outside the pattern → 400",
  refusedOn(badPatternValue, "crm_id"),
  j(badPatternValue.body),
);
const goodCreate = await call("POST", `${B}/customers`, {
  email: "b5@example.com",
  metadata: { tier: "gold", crm_id: "A-1024", free: { any: true } },
});
check(
  "§B a conforming create → 201 (unruled key allowed, strict off)",
  goodCreate.status === 201,
  j(goodCreate.body),
);

// ── § C · customer update ───────────────────────────────────────────────────────
const cus = goodCreate.body.id as string;
const badUpdate = await call("PATCH", `${B}/customers/${cus}`, {
  metadata: { tier: "nope", crm_id: "A-1024" },
});
check("§C update with a bad value → 400", refusedOn(badUpdate, "tier"), j(badUpdate.body));
const removeKey = await call("PATCH", `${B}/customers/${cus}`, { metadata: { tier: "gold" } });
check(
  "§C update that removes a ruled key → 200",
  removeKey.status === 200 && !("crm_id" in removeKey.body.metadata),
  j(removeKey.body),
);
const goodUpdate = await call("PATCH", `${B}/customers/${cus}`, {
  metadata: { tier: "silver", crm_id: "A-2048" },
});
check(
  "§C conforming update → 200",
  goodUpdate.status === 200 && goodUpdate.body.metadata.tier === "silver",
  j(goodUpdate.body),
);
const nonMeta = await call("PATCH", `${B}/customers/${cus}`, { company: "Acme" });
check(
  "§C update that does not send metadata is not checked",
  nonMeta.status === 200,
  j(nonMeta.body),
);

// The record created before the rules existed.
const legacyEmail = await call("PATCH", `${B}/customers/${legacy.publicId}`, {
  company: "Legacy Co",
});
check("§C old record: a non-metadata edit passes", legacyEmail.status === 200, j(legacyEmail.body));
const legacyKeep = await call("PATCH", `${B}/customers/${legacy.publicId}`, {
  metadata: { tier: "bronze", note: "new note" },
});
check(
  "§C old record: bad key sent back unchanged → 200, other key changes",
  legacyKeep.status === 200 &&
    legacyKeep.body.metadata.note === "new note" &&
    legacyKeep.body.metadata.tier === "bronze",
  j(legacyKeep.body),
);
const legacyChange = await call("PATCH", `${B}/customers/${legacy.publicId}`, {
  metadata: { tier: "tin" },
});
check(
  "§C old record: changing the bad key to another bad value → 400",
  refusedOn(legacyChange, "tier"),
  j(legacyChange.body),
);

// ── § D · strict mode ───────────────────────────────────────────────────────────
const strictOn = await call("PATCH", `${B}/metadata_rule_settings`, { customer: { strict: true } });
check(
  "§D strict on for customer only",
  strictOn.status === 200 &&
    strictOn.body.customer.strict &&
    !strictOn.body.subscription.strict &&
    strictOn.body.customer.metadata_validation === "on",
  j(strictOn.body),
);
const unknown = await call("POST", `${B}/customers`, {
  email: "d1@example.com",
  metadata: { crm_id: "A-1111", extra: 1 },
});
check("§D strict refuses an unknown key", refusedOn(unknown, "extra"), j(unknown.body));
const legacyUnknown = await call("PATCH", `${B}/customers/${legacy.publicId}`, {
  metadata: { tier: "bronze", note: "new note", seen: 1 },
});
check(
  "§D strict refuses a NEW unknown key on an old record",
  refusedOn(legacyUnknown, "seen"),
  j(legacyUnknown.body),
);
const legacyStrictKeep = await call("PATCH", `${B}/customers/${legacy.publicId}`, {
  metadata: { tier: "bronze", note: "new note" },
});
check(
  "§D strict keeps an unchanged stored unknown key",
  legacyStrictKeep.status === 200,
  j(legacyStrictKeep.body),
);
await call("DELETE", `${B}/metadata_key_rules/${tier.body.id}`);
const archivedKey = await call("PATCH", `${B}/customers/${cus}`, {
  metadata: { tier: "anything", crm_id: "A-2048" },
});
check(
  "§D an archived rule's key counts as unknown under strict",
  refusedOn(archivedKey, "tier"),
  j(archivedKey.body),
);
await call("PATCH", `${B}/metadata_rule_settings`, { customer: { strict: false } });
const archivedFree = await call("PATCH", `${B}/customers/${cus}`, {
  metadata: { tier: "anything", crm_id: "A-2048" },
});
check(
  "§D strict off: the archived rule's key is free again",
  archivedFree.status === 200,
  j(archivedFree.body),
);

// ── § E · subscriptions: every writer ───────────────────────────────────────────
await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "subscription",
  key: "seats",
  data_type: "number",
});
const plan = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  id: "mdr-plan-monthly",
  type: "recurring",
  // Per unit, so a quantity change is valid and only the metadata rule can refuse it.
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const subBad = await call("POST", `${B}/customers/${cus}/subscriptions`, {
  items: [{ price: "mdr-plan-monthly" }],
  auto_collection: "off",
  metadata: { seats: "ten" },
});
check("§E subscription create with a bad value → 400", refusedOn(subBad, "seats"), j(subBad.body));
const subGood = await call("POST", `${B}/customers/${cus}/subscriptions`, {
  items: [{ price: "mdr-plan-monthly" }],
  auto_collection: "off",
  metadata: { seats: 10 },
});
check("§E subscription create conforming → 201", subGood.status === 201, j(subGood.body));
const subId = subGood.body.id as string;
if (!subId) {
  for (const [name, pass, detail] of checks)
    console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `\n      ${detail}`}`);
  console.log("  ✗ cannot continue §E without a subscription:", j(subGood.body));
  process.exit(1);
}
const settingsBad = await call("PATCH", `${B}/subscriptions/${subId}`, {
  metadata: { seats: true },
});
check(
  "§E settings update with a bad value → 400",
  refusedOn(settingsBad, "seats"),
  j(settingsBad.body),
);
const settingsGood = await call("PATCH", `${B}/subscriptions/${subId}`, {
  metadata: { seats: 12 },
});
check("§E settings update conforming → 200", settingsGood.status === 200, j(settingsGood.body));

const [subRow] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.publicId, subId)).limit(1),
);
const [item] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, subRow!.id))
    .limit(1),
);
const changeBad = await call("POST", `${B}/subscriptions/${subId}/change`, {
  changes: [{ item: item!.publicId, quantity: 3 }],
  metadata: { seats: "x" },
});
const [itemAfterChange] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptionItems).where(eq(subscriptionItems.id, item!.id)).limit(1),
);
check(
  "§E /change with a bad value → 400 and the quantity did not move",
  refusedOn(changeBad, "seats") && itemAfterChange!.quantity === item!.quantity,
  `${j(changeBad.body)} qty=${itemAfterChange!.quantity}`,
);
const ufiBad = await call("POST", `${B}/subscriptions/${subId}/update_for_items`, {
  items: [{ price: "mdr-plan-monthly", quantity: 4 }],
  metadata: { seats: "y" },
});
const [itemAfterUfi] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptionItems).where(eq(subscriptionItems.id, item!.id)).limit(1),
);
check(
  "§E update_for_items with a bad value → 400 BEFORE any item moves",
  refusedOn(ufiBad, "seats") && itemAfterUfi!.quantity === item!.quantity,
  `${j(ufiBad.body)} qty=${itemAfterUfi!.quantity}`,
);

// ── § F · checkout mint checks types only; internal writers bypass ──────────────
await call("PATCH", `${B}/metadata_rule_settings`, { subscription: { strict: true } });
await call("POST", `${B}/metadata_key_rules`, {
  entity_type: "subscription",
  key: "region",
  data_type: "enum",
  enum_options: ["us", "eu"],
});
const coBad = await call("POST", `${B}/checkout_sessions`, {
  price: "mdr-plan-monthly",
  metadata: { seats: "z" },
});
check("§F checkout mint refuses a bad type", refusedOn(coBad, "seats"), j(coBad.body));
const coLoose = await call("POST", `${B}/checkout_sessions`, {
  price: "mdr-plan-monthly",
  metadata: { seats: 5, campaign: "autumn" },
});
check(
  "§F checkout mint skips strict (unknown key)",
  coLoose.status === 201 || coLoose.status === 200,
  j(coLoose.body),
);
let importerOk = true;
try {
  await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "import@example.com",
    metadata: { tier: 12, crm_id: "whatever" },
    metadataRules: "off",
  });
} catch {
  importerOk = false;
}
check("§F importer scope (off) stores a non-conforming record", importerOk);
let integrationRefused = false;
try {
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: legacy.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    autoCollection: "off",
    metadata: { hubspot_deal_id: "D-1", seats: "many" },
    metadataRules: "supplied_only",
  });
} catch (e) {
  integrationRefused = (e as Error).name === "MetadataRuleError";
}
check("§F integration scope (supplied_only) still refuses a bad type", integrationRefused);
let integrationOk = true;
try {
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: legacy.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    autoCollection: "off",
    metadata: { hubspot_deal_id: "D-2" },
    metadataRules: "supplied_only",
  });
} catch {
  integrationOk = false;
}
check("§F integration scope skips strict", integrationOk);

// ── § G · isolation ─────────────────────────────────────────────────────────────
await call("PATCH", `${BB}/metadata_rule_settings`, { customer: { metadata_validation: "on" } });
const otherBizCreate = await call("POST", `${BB}/customers`, {
  email: "g1@example.com",
  metadata: { tier: "copper", anything: true },
});
check(
  "§G another business's rules never apply",
  otherBizCreate.status === 201,
  j(otherBizCreate.body),
);
const otherOrgList = await call("GET", `${B}/metadata_key_rules`, undefined, { key: otherSecret });
check(
  "§G another organization cannot read the rules",
  otherOrgList.status === 404 || otherOrgList.status === 403,
  `${otherOrgList.status}`,
);

// ── § N · nested paths, object/array, strict per level, conflicts ───────────────
const mk = (key: string, data_type: string, extra: Record<string, unknown> = {}) =>
  call("POST", `${BB}/metadata_key_rules`, {
    entity_type: "subscription",
    key,
    data_type,
    ...extra,
  });
await call("PATCH", `${BB}/metadata_rule_settings`, {
  subscription: { metadata_validation: "on" },
});
check("§N object parent rule", (await mk("billing", "object")).status === 201);
check(
  "§N nested string rule",
  (await mk("billing.po", "string", { pattern: "PO-\\d+" })).status === 201,
);
check(
  "§N nested rule 3 levels deep",
  (await mk("billing.address.city", "string", { max_length: 10 })).status === 201,
);
check("§N array rule", (await mk("tags", "array")).status === 201);
check("§N free-form object rule", (await mk("extra", "object")).status === 201);
const tooDeep = await mk("a.b.c.d.e.f", "string");
check(
  "§N a 6-level path is refused (param key)",
  tooDeep.status === 400 && tooDeep.body.error.param === "key",
  j(tooDeep.body),
);
const badSeg = await mk("billing.p o", "string");
check(
  "§N an unsafe segment is refused",
  badSeg.status === 400 && badSeg.body.error.param === "key",
  j(badSeg.body),
);
const childOfScalar = await mk("tags.first", "string");
check(
  "§N a rule below an array rule is refused",
  childOfScalar.status === 400 && /Only an object rule/.test(childOfScalar.body.error.message),
  j(childOfScalar.body),
);
const scalarParent = await mk("billing.address", "string");
check(
  "§N a scalar rule at a path with child rules is refused",
  scalarParent.status === 400 && scalarParent.body.error.param === "data_type",
  j(scalarParent.body),
);
const twice = await mk("billing.po", "number");
check(
  "§N the same path twice is refused",
  twice.status === 400 && /already exists/.test(twice.body.error.message),
  j(twice.body),
);

const bbCus = await createCustomer({
  organizationId: orgId,
  businessId: bizB.id,
  email: "n@example.com",
});
const subN = (metadata: unknown) =>
  call("POST", `${BB}/customers/${bbCus.publicId}/subscriptions`, {
    items: [{ price: "mdr-plan-b" }],
    auto_collection: "off",
    metadata,
  });
const planB = await createProduct({ organizationId: orgId, businessId: bizB.id, name: "Plan B" });
await createPrice({
  organizationId: orgId,
  businessId: bizB.id,
  productId: planB.id,
  id: "mdr-plan-b",
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 500,
  interval: "month",
});
const nGood = await subN({
  billing: { po: "PO-7", address: { city: "Pune" } },
  tags: ["a"],
  extra: { any: { deep: 1 } },
});
check("§N a conforming nested write → 201", nGood.status === 201, j(nGood.body));
const nPattern = await subN({ billing: { po: "7", address: { city: "Pune" } } });
check(
  "§N a nested value outside its pattern → 400 naming the path",
  refusedOn(nPattern, "billing.po"),
  j(nPattern.body),
);
const nAbsent = await subN({ billing: { po: "PO-1", address: {} } });
check("§N a nested ruled path that is absent → 201", nAbsent.status === 201, j(nAbsent.body));
const nLong = await subN({ billing: { address: { city: "Thiruvananthapuram" } } });
check(
  "§N a value 3 levels deep is checked → 400 naming the path",
  refusedOn(nLong, "billing.address.city"),
  j(nLong.body),
);
// `billing.address` has no rule of its own, so the failure is reported on the path through it.
const nBlocked = await subN({ billing: { po: "PO-1", address: "flat" } });
check(
  "§N a non-object intermediate → 400 on the path through it",
  nBlocked.status === 400 &&
    /"billing.address.city" cannot be checked: "billing.address" is string/.test(
      nBlocked.body.error.message,
    ),
  j(nBlocked.body),
);
const nParentTyped = await subN({ billing: "flat" });
check(
  "§N a parent with its own object rule is refused by that rule",
  refusedOn(nParentTyped, "billing"),
  j(nParentTyped.body),
);
const nArray = await subN({ billing: { address: { city: "Pune" } }, tags: "a" });
check("§N array type → 400 when not an array", refusedOn(nArray, "tags"), j(nArray.body));

await call("PATCH", `${BB}/metadata_rule_settings`, { subscription: { strict: true } });
const sTop = await subN({ billing: { address: { city: "Pune" } }, other: 1 });
check("§N strict top level: uncovered key refused", refusedOn(sTop, "other"), j(sTop.body));
const sNested = await subN({ billing: { address: { city: "Pune", zip: "1" } } });
check(
  "§N strict nested level: uncovered child refused",
  refusedOn(sNested, "billing.address.zip"),
  j(sNested.body),
);
const sFree = await subN({
  billing: { address: { city: "Pune" } },
  extra: { anything: [1, { x: 2 }] },
});
check(
  "§N strict: inside an object rule with no child rules is free-form",
  sFree.status === 201,
  j(sFree.body),
);
await call("PATCH", `${BB}/metadata_rule_settings`, {
  subscription: { metadata_validation: "off" },
});
const offAgain = await subN({ billing: "flat", other: 1 });
check(
  "§N switch off again: strict and rules are ignored",
  offAgain.status === 201,
  j(offAgain.body),
);

// ── § O · number bounds and array items (0333): the limit_overrides shape ────────
const bizC = await createBusiness({
  organizationId: orgId,
  name: "Limits Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const BC = `/v1/businesses/${bizC.publicId}`;
const mkC = (key: string, data_type: string, extra: Record<string, unknown> = {}) =>
  call("POST", `${BC}/metadata_key_rules`, {
    entity_type: "subscription",
    key,
    data_type,
    ...extra,
  });

const minOverMax = await mkC("n", "number", { min: 5, max: 1 });
check(
  "§O min greater than max is refused (param min)",
  minOverMax.status === 400 && minOverMax.body.error.param === "min",
  j(minOverMax.body),
);
const intOnString = await mkC("s", "string", { integer: true });
check(
  "§O integer on a string rule is refused",
  intOnString.status === 400 && /number type/.test(intOnString.body.error.message),
  j(intOnString.body),
);
const itemsOnNumber = await mkC("m", "number", { item_type: "string" });
check(
  "§O item_type on a number rule is refused",
  itemsOnNumber.status === 400 && /array type/.test(itemsOnNumber.body.error.message),
  j(itemsOnNumber.body),
);

const created = [
  await mkC("core_destination", "enum", { enum_options: ["gs", "gds"] }),
  await mkC("additional_destinations", "array", {
    item_type: "string",
    item_enum_options: ["gs", "gds"],
  }),
  await mkC("limit_overrides", "object"),
  ...(await Promise.all(
    ["accounts", "schedules", "dataSources", "queries", "schedulesPerSheet", "usersCount"].map(
      (k) => mkC(`limit_overrides.${k}`, "number", { integer: true, min: 0 }),
    ),
  )),
  // item_type is left out on purpose: allowed item values imply string items.
  await mkC("limit_overrides.scheduling", "array", {
    item_enum_options: ["Hourly", "Daily", "Weekly", "Monthly"],
  }),
  await mkC("limit_overrides.dataSourceType", "string"),
];
check(
  "§O the limit_overrides rules are created (11 rules)",
  created.length === 11 && created.every((r) => r.status === 201),
  j(created.filter((r) => r.status !== 201).map((r) => r.body)),
);
const accountsRule = created.find((r) => r.body.key === "limit_overrides.accounts")!.body;
const schedRule = created.find((r) => r.body.key === "limit_overrides.scheduling")!.body;
check(
  "§O a rule serialises integer, min, max and the item fields",
  accountsRule.integer === true &&
    accountsRule.min === 0 &&
    accountsRule.max === null &&
    schedRule.item_type === "string" &&
    j(schedRule.item_enum_options) === j(["Hourly", "Daily", "Weekly", "Monthly"]) &&
    schedRule.min_items === null,
  j({ accountsRule, schedRule }),
);
const lowerMax = await call("PATCH", `${BC}/metadata_key_rules/${accountsRule.id}`, { max: -1 });
check(
  "§O a PATCH of max below the stored min is refused",
  lowerMax.status === 400 && lowerMax.body.error.param === "min",
  j(lowerMax.body),
);

await call("PATCH", `${BC}/metadata_rule_settings`, {
  subscription: { metadata_validation: "on", strict: true },
});
const cCus = await createCustomer({
  organizationId: orgId,
  businessId: bizC.id,
  email: "limits@example.com",
});
const planC = await createProduct({ organizationId: orgId, businessId: bizC.id, name: "Plan C" });
await createPrice({
  organizationId: orgId,
  businessId: bizC.id,
  productId: planC.id,
  id: "mdr-plan-c",
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 700,
  interval: "month",
});
const subC = await call("POST", `${BC}/customers/${cCus.publicId}/subscriptions`, {
  items: [{ price: "mdr-plan-c" }],
  auto_collection: "off",
});
check("§O a subscription without metadata → 201", subC.status === 201, j(subC.body));
const payload = {
  core_destination: "gs",
  additional_destinations: ["gds"],
  limit_overrides: {
    accounts: 150,
    schedules: 500,
    dataSources: 40,
    queries: 2000,
    schedulesPerSheet: 10,
    usersCount: 15,
    scheduling: ["Hourly", "Daily"],
    dataSourceType: "All",
  },
};
// jsonb stores object keys in its own order, so compare with keys sorted.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1)))
      : x,
  );
const patchC = (metadata: unknown) =>
  call("PATCH", `${BC}/subscriptions/${subC.body.id}`, { metadata });
const withLimits = (lo: Record<string, unknown>) => ({
  ...payload,
  limit_overrides: { ...payload.limit_overrides, ...lo },
});
const okPayload = await patchC(payload);
check(
  "§O the exact limit_overrides payload is accepted (strict on)",
  okPayload.status === 200 && canon(okPayload.body.metadata) === canon(payload),
  j(okPayload.body),
);
const neg = await patchC(withLimits({ accounts: -5 }));
check(
  "§O accounts -5 → 400 naming the path and the bound",
  refusedOn(neg, "limit_overrides.accounts") &&
    /whole number of 0 or more/.test(neg.body.error.message),
  j(neg.body),
);
const frac = await patchC(withLimits({ accounts: 1.5 }));
check("§O accounts 1.5 → 400", refusedOn(frac, "limit_overrides.accounts"), j(frac.body));
const yearly = await patchC(withLimits({ scheduling: ["Hourly", "Yearly"] }));
check(
  "§O scheduling with Yearly → 400 naming index 1",
  refusedOn(yearly, "limit_overrides.scheduling") &&
    yearly.body.error.message.includes('"limit_overrides.scheduling"[1]'),
  j(yearly.body),
);
const xyz = await patchC({ ...payload, additional_destinations: ["xyz"] });
check(
  "§O additional_destinations [xyz] → 400",
  refusedOn(xyz, "additional_destinations"),
  j(xyz.body),
);
const typo = await patchC(withLimits({ schedule: 500 }));
check(
  "§O a typo (limit_overrides.schedule) is refused under strict",
  refusedOn(typo, "limit_overrides.schedule") && /not allowed/.test(typo.body.error.message),
  j(typo.body),
);
const [cRow] = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.publicId, subC.body.id)).limit(1),
);
check(
  "§O a refused write stores nothing (metadata is still the accepted payload)",
  canon(cRow?.metadata) === canon(payload),
  j(cRow?.metadata),
);
const noLimits = await patchC({ core_destination: "gds" });
check(
  "§O a payload without limit_overrides is accepted",
  noLimits.status === 200,
  j(noLimits.body),
);

// ── § P · observed keys (suggestions) ───────────────────────────────────────────
// Values only for few, short values; never another business's keys; cached per business.
const bizP = await createBusiness({
  organizationId: orgId,
  name: "Observed Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const BP = `/v1/businesses/${bizP.publicId}`;
const LONG = "x".repeat(100);
for (let i = 0; i < 30; i++)
  await createCustomer({
    organizationId: orgId,
    businessId: bizP.id,
    email: `obs-${i}@example.com`,
    metadata: {
      crm_id: `CRM-${1000 + i}`,
      tier: ["gold", "silver", "bronze"][i % 3],
      limits: { plan: i % 2 ? "a" : "b", seats: 5 },
      note: LONG,
      tags: ["x", i % 2 ? "y" : "z"],
    },
  });
await createCustomer({
  organizationId: orgId,
  businessId: bizB.id,
  email: "obs-b@example.com",
  metadata: { bizb_only: "secret-b" },
});
const otherBiz = await createBusiness({
  organizationId: other.organization.id,
  name: "Observed Other Org Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
await createCustomer({
  organizationId: other.organization.id,
  businessId: otherBiz.id,
  email: "obs-o@example.com",
  metadata: { other_org_only: "secret-o" },
});
clearObservedCache();
const obs = await call("GET", `${BP}/metadata_observed_keys?entity_type=customer`);
const byPath = new Map<string, any>((obs.body.data ?? []).map((k: any) => [k.path, k]));
check(
  "§P observed keys → 200, a list",
  obs.status === 200 && Array.isArray(obs.body.data),
  j(obs.body),
);
check(
  "§P a high-cardinality key (30 ids) returns no values",
  byPath.get("crm_id")?.distinct_values === 30 && byPath.get("crm_id")?.values === null,
  j(byPath.get("crm_id")),
);
check(
  "§P a key with few short values returns them with counts",
  j(
    byPath
      .get("tier")
      ?.values?.map((v: any) => v.value)
      .sort(),
  ) === j(["bronze", "gold", "silver"]),
  j(byPath.get("tier")),
);
check(
  "§P a key with a long value returns no values",
  byPath.get("note")?.distinct_values === 1 && byPath.get("note")?.values === null,
  j(byPath.get("note")),
);
check(
  "§P one level of nesting is reported, with its type",
  byPath.get("limits")?.type === "object" &&
    byPath.get("limits.plan")?.type === "string" &&
    byPath.get("limits.seats")?.type === "number" &&
    j(byPath.get("limits.seats")?.values) === j([{ value: 5, rows: 30 }]),
  j([byPath.get("limits"), byPath.get("limits.plan"), byPath.get("limits.seats")]),
);
check(
  "§P an array key reports its item values",
  byPath.get("tags")?.type === "array" &&
    j(
      byPath
        .get("tags")
        ?.item_values?.map((v: any) => v.value)
        .sort(),
    ) === j(["x", "y", "z"]),
  j(byPath.get("tags")),
);
check(
  "§P another business's keys never appear (same org, other org)",
  !byPath.has("bizb_only") && !byPath.has("other_org_only") && !j(obs.body).includes("secret-"),
  j([...byPath.keys()]),
);
check(
  "§P a missing entity_type → 400",
  (await call("GET", `${BP}/metadata_observed_keys`)).status === 400,
);
check(
  "§P another organization's key cannot read this business",
  (
    await call("GET", `${BP}/metadata_observed_keys?entity_type=customer`, undefined, {
      key: otherSecret,
    })
  ).status === 404,
);
// The cache is per (business, entity): a new key in this business stays hidden until it expires,
// while another business answers from its own data.
await createCustomer({
  organizationId: orgId,
  businessId: bizP.id,
  email: "obs-new@example.com",
  metadata: { brand_new: "1" },
});
const cached = await call("GET", `${BP}/metadata_observed_keys?entity_type=customer`);
const bOwn = await call("GET", `${BB}/metadata_observed_keys?entity_type=customer`);
check(
  "§P the cache answers a repeat read for the same business",
  !cached.body.data.some((k: any) => k.path === "brand_new"),
  j(cached.body.data.map((k: any) => k.path)),
);
check(
  "§P the cache is per business: another business reads its own keys",
  bOwn.body.data.some((k: any) => k.path === "bizb_only") &&
    !bOwn.body.data.some((k: any) => k.path === "crm_id"),
  j(bOwn.body.data.map((k: any) => k.path)),
);
clearObservedCache();
const fresh = await call("GET", `${BP}/metadata_observed_keys?entity_type=customer`);
check(
  "§P after the cache clears, the new key appears",
  fresh.body.data.some((k: any) => k.path === "brand_new"),
  j(fresh.body.data.map((k: any) => k.path)),
);

// ── report ──────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
await app.close();
await closeDb();
console.log(
  failed
    ? `\n❌ METADATA RULES: FAIL (${failed}/${checks.length})`
    : `\n✅ METADATA RULES: PASS (${checks.length} checks)`,
);
process.exit(failed ? 1 : 0);
