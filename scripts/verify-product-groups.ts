/**
 * Product Groups (Phase 13) — integration coverage:
 *  - create group → appears in list; product filed under a group; product without
 *    a group → auto-created per-business "Default" group,
 *  - list/filter products by group,
 *  - create/update product with a bad group id → rejected,
 *  - move a product to another group,
 *  - archive guards: can't archive a group with active products, can't archive Default,
 *    empty group archives fine + drops from the active list,
 *  - code uniqueness per business,
 *  - importer round-trips item_family → product_groups (idempotent),
 *  - RLS: a group is invisible cross-org.
 *
 *   pnpm verify:product-groups
 */
import { closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  createProduct,
  updateProduct,
  listProducts,
  createProductGroup,
  updateProductGroup,
  setProductGroupActive,
  listProductGroups,
  CatalogError,
  SlugConflictError,
} from "@/modules/catalog/service";
import { importFromSource } from "@/modules/migration/import";
import { FixtureSource } from "@/modules/migration/fixture";

const org = await createOrganization({ name: "PG Org" });
const orgId = org.organization.id;
const biz = await createBusiness({ organizationId: orgId, name: "Biz", defaultCurrency: "USD" });

const checks: Array<[string, boolean]> = [];

// 1) Create a group; file a product under it; a product with no group → Default.
{
  const group = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "Core",
    id: "core",
  });
  const groups = await listProductGroups(orgId, biz.id);
  const inList = groups.some((g) => g.publicId === group.publicId);

  const filed = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro",
    productGroupPublicId: group.publicId,
  });
  const ungrouped = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Loose",
  });
  const groupsAfter = await listProductGroups(orgId, biz.id, { includeArchived: true });
  const def = groupsAfter.find((g) => g.publicId === "default");

  console.log(
    `group in list=${inList}; filed under=${filed.groupPublicId === group.publicId}; default auto-created=${!!def}; ungrouped→default=${ungrouped.groupPublicId === def?.publicId}`,
  );
  checks.push(
    ["created group appears in list", inList],
    ["product filed under the given group", filed.groupPublicId === group.publicId],
    ["a Default group is auto-created", !!def],
    ["product with no group → Default group", ungrouped.groupPublicId === def?.publicId],
  );
}

// 2) Filter products by group.
{
  const group = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "Filterable",
    id: "filt",
  });
  const a = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "F1",
    productGroupPublicId: group.publicId,
  });
  await createProduct({ organizationId: orgId, businessId: biz.id, name: "F2" }); // Default group
  const g = (await listProductGroups(orgId, biz.id)).find((x) => x.publicId === group.publicId)!;
  const inGroup = await listProducts(orgId, biz.id, { groupId: g.id });
  console.log(
    `filter by group → ${inGroup.length} product(s), only F1=${inGroup.length === 1 && inGroup[0]?.publicId === a.publicId}`,
  );
  checks.push([
    "list products filtered by group",
    inGroup.length === 1 && inGroup[0]?.publicId === a.publicId,
  ]);
}

// 3) Bad group id on create/update → CatalogError.
{
  let createRejected = false;
  try {
    await createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name: "X",
      productGroupPublicId: "pgrp_nope",
    });
  } catch (e) {
    createRejected = e instanceof CatalogError;
  }
  const p = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Movable" });
  let updateRejected = false;
  try {
    await updateProduct({
      organizationId: orgId,
      businessId: biz.id,
      productPublicId: p.publicId,
      productGroupPublicId: "pgrp_nope",
    });
  } catch (e) {
    updateRejected = e instanceof CatalogError;
  }
  console.log(`bad group create-rejected=${createRejected} update-rejected=${updateRejected}`);
  checks.push(
    ["create with unknown group rejected", createRejected],
    ["update with unknown group rejected", updateRejected],
  );
}

// 4) Move a product between groups.
{
  const from = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "From",
    id: "from",
  });
  const to = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "To",
    id: "to",
  });
  const p = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Mover",
    productGroupPublicId: from.publicId,
  });
  const moved = await updateProduct({
    organizationId: orgId,
    businessId: biz.id,
    productPublicId: p.publicId,
    productGroupPublicId: to.publicId,
  });
  console.log(`moved ${from.publicId} → ${moved?.groupPublicId} (want ${to.publicId})`);
  checks.push(["product moved to another group", moved?.groupPublicId === to.publicId]);
}

// 5) Archive guards.
{
  const withProduct = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "HasProducts",
    id: "hasprod",
  });
  await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Blocker",
    productGroupPublicId: withProduct.publicId,
  });
  let blockedNonEmpty = false;
  try {
    await setProductGroupActive(orgId, biz.id, withProduct.publicId, false);
  } catch (e) {
    blockedNonEmpty = e instanceof CatalogError;
  }

  const defGroup = (await listProductGroups(orgId, biz.id)).find((g) => g.publicId === "default")!;
  let blockedDefault = false;
  try {
    await setProductGroupActive(orgId, biz.id, defGroup.publicId, false);
  } catch (e) {
    blockedDefault = e instanceof CatalogError;
  }

  const empty = await createProductGroup({
    organizationId: orgId,
    businessId: biz.id,
    name: "Empty",
    id: "empty",
  });
  const archived = await setProductGroupActive(orgId, biz.id, empty.publicId, false);
  const activeList = await listProductGroups(orgId, biz.id);
  const allList = await listProductGroups(orgId, biz.id, { includeArchived: true });

  console.log(
    `archive: nonEmpty-blocked=${blockedNonEmpty} default-blocked=${blockedDefault} empty-archived=${archived?.active === false} hidden=${!activeList.some((g) => g.publicId === empty.publicId)}`,
  );
  checks.push(
    ["cannot archive a group with active products", blockedNonEmpty],
    ["cannot archive the Default group", blockedDefault],
    ["empty group archives", archived?.active === false],
    [
      "archived group hidden from active list",
      !activeList.some((g) => g.publicId === empty.publicId),
    ],
    ["archived group kept in include_archived", allList.some((g) => g.publicId === empty.publicId)],
  );
}

// 6) Code uniqueness per business.
{
  await createProductGroup({ organizationId: orgId, businessId: biz.id, name: "Uniq", id: "uniq" });
  let dupRejected = false;
  try {
    await createProductGroup({
      organizationId: orgId,
      businessId: biz.id,
      name: "Uniq2",
      id: "uniq",
    });
  } catch (e) {
    dupRejected = e instanceof SlugConflictError;
  }
  console.log(`duplicate id rejected=${dupRejected}`);
  checks.push(["duplicate group id rejected", dupRejected]);
}

// 7) Importer round-trip: item_family → product_groups (idempotent).
{
  const bizImp = await createBusiness({
    organizationId: orgId,
    name: "Import Biz",
    defaultCurrency: "USD",
  });
  const source = new FixtureSource({
    name: "fixture-groups",
    catalog: {
      groups: [
        { sourceId: "fam_1", name: "Family One" },
        { sourceId: "fam_2", name: "Family Two" },
      ],
      products: [
        { sourceId: "plan_a", kind: "plan", name: "Plan A", groupSourceId: "fam_1" },
        { sourceId: "plan_b", kind: "plan", name: "Plan B", groupSourceId: "fam_1" },
        { sourceId: "plan_c", kind: "plan", name: "Plan C", groupSourceId: "fam_2" },
      ],
      prices: [
        {
          sourceId: "price_a",
          productSourceId: "plan_a",
          model: "flat",
          amountMinor: 1000,
          currency: "USD",
          interval: "month",
          intervalCount: 1,
        },
        {
          sourceId: "price_b",
          productSourceId: "plan_b",
          model: "flat",
          amountMinor: 2000,
          currency: "USD",
          interval: "month",
          intervalCount: 1,
        },
        {
          sourceId: "price_c",
          productSourceId: "plan_c",
          model: "flat",
          amountMinor: 3000,
          currency: "USD",
          interval: "month",
          intervalCount: 1,
        },
      ],
    },
  });
  await importFromSource({ organizationId: orgId, businessId: bizImp.id, source });
  const groups = await listProductGroups(orgId, bizImp.id, { includeArchived: true });
  const fam1 = groups.find((g) => g.publicId === "fam_1");
  const fam2 = groups.find((g) => g.publicId === "fam_2");
  const products = await listProducts(orgId, bizImp.id, { includeArchived: true });
  const planA = products.find((p) => p.name === "Plan A");
  const planC = products.find((p) => p.name === "Plan C");
  const namedRight = fam1?.name === "Family One" && fam2?.name === "Family Two";
  const filedRight = planA?.productGroupId === fam1?.id && planC?.productGroupId === fam2?.id;

  // Re-import: idempotent — no new groups.
  await importFromSource({ organizationId: orgId, businessId: bizImp.id, source });
  const groups2 = await listProductGroups(orgId, bizImp.id, { includeArchived: true });
  const noDupes =
    groups2.filter((g) => g.publicId === "fam_1").length === 1 &&
    groups2.filter((g) => g.publicId === "fam_2").length === 1;

  console.log(
    `importer: 2 groups=${!!fam1 && !!fam2} named=${namedRight} filed=${filedRight} idempotent=${noDupes}`,
  );
  checks.push(
    ["importer creates a group per item_family", !!fam1 && !!fam2],
    ["importer carries the family name", namedRight],
    ["importer files products under their family group", filedRight],
    ["re-import is idempotent (no duplicate groups)", noDupes],
  );
}

// 8) RLS: a group is invisible cross-org.
{
  const org2 = await createOrganization({ name: "PG Org 2" });
  const seen = await listProductGroups(org2.organization.id, biz.id, { includeArchived: true });
  console.log(`cross-org group visibility → ${seen.length} (want 0)`);
  checks.push(["group invisible to another org (RLS)", seen.length === 0]);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ PRODUCT GROUPS: PASS" : "❌ PRODUCT GROUPS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
