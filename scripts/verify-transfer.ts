/**
 * H3 (TL-1..3) — Transfer Configurations + sample data.
 *  T1 catalog+coupons+tax+settings copy (test→test) with a per-object report
 *  T2 re-run merges (updates in place, no duplicates)
 *  T3 destination LIVE = merge-only (wipe ignored; a pre-existing live object survives)
 *  T4 never copies customers/subscriptions
 *  T5 sample_data create + delete
 *  T6 prefixes: the destination keeps its own unless `numbering` sets them; clashes refused
 *  T7 storefront: the destination keeps its return/cancel URLs and portal error text
 *  T8 live guard: no override = nothing written; each override condition refuses alone
 *  T9 live override: writes and audits field by field; secrets never leave in clear
 *  T10 tax on live: components updated in place, issued invoices keep their link
 *  T11 test twins: one run covers both pairs; a blocked twin leaves live untouched
 *  T12 HTTP: preview, key refused, roles, 409 on a stale preview
 *
 *   pnpm verify:transfer
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  createProduct,
  createPrice,
  listProducts,
  listPrices,
  getProductByPublicId,
} from "@/modules/catalog/service";
import { createCoupon, listCoupons } from "@/modules/coupons/service";
import { createFlatTaxRate, listTaxRegions } from "@/modules/tax/service";
import { createCustomer } from "@/modules/customers/service";
import { updateBusiness, getBusinessByPublicId } from "@/modules/tenancy/service";
import {
  runTransfer,
  previewTransfer,
  listTransfers,
  TransferError,
  TransferConflictError,
  TransferForbiddenError,
} from "@/modules/transfer/service";
import { createSampleData, deleteSampleData } from "@/modules/transfer/sample-data";
import { saveSmtpSettings } from "@/modules/emails/smtp-service";
import { readSmtpPassword } from "@/modules/emails/smtp-config";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { buildApp } from "@/index";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import {
  products,
  customers,
  businesses,
  auditLogs,
  authTokens,
  invoices,
  invoiceLineItems,
  appliedTaxes,
  taxProfiles,
  taxRegions,
  taxRateComponents,
  transferConfigurations,
} from "@db/schema";

// Not a test of the MFA mandate — see scripts/lib/mfa-policy.ts. Must precede any fixture.
pinMfaMandateOff();

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Transfer Org" });
const orgId = org.organization.id;

async function seedSource(biz: { id: string; publicId: string }) {
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro Plan",
    id: "pro",
    kind: "plan",
  });
  await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    id: "pro-monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "WELCOME",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "once",
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: biz.id,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  await updateBusiness(orgId, biz.publicId, { invoicePrefix: "SRC", defaultDueDays: 15 });
}

// ── T1: test→test copy ────────────────────────────────────────────────────────
const src = await createBusiness({
  organizationId: orgId,
  name: "Source",
  defaultCurrency: "USD",
  livemode: "test",
});
await seedSource(src);
const dest = await createBusiness({
  organizationId: orgId,
  name: "Dest",
  defaultCurrency: "USD",
  livemode: "test",
});
const job = await runTransfer({
  organizationId: orgId,
  sourceBusinessId: src.id,
  destinationBusinessId: dest.id,
});
ok("T1: transfer succeeded", job.status === "succeeded");
const destProducts = await listProducts(orgId, dest.id);
ok(
  "T1: product copied by slug id",
  destProducts.some((p) => p.publicId === "pro"),
);
const destPrices = await listPrices(orgId, dest.id);
ok(
  "T1: price copied by slug id + amount",
  destPrices.some(
    (p) => p.price.publicId === "pro-monthly" && Number(p.price.amountMinor) === 10000,
  ),
);
const destCoupons = await listCoupons(orgId, dest.id);
ok(
  "T1: coupon copied",
  destCoupons.some((c) => c.code === "WELCOME"),
);
// The whole four-level tax config (profile → region → components → registrations)
// must copy, not just a rate row: a region whose components did not come across would
// tax at 0 while looking configured.
const destTax = await listTaxRegions(orgId, dest.id);
const destGb = destTax.find((r) => r.region.country === "GB");
ok("T1: tax region copied", !!destGb);
ok(
  "T1: tax component copied with its rate",
  (destGb?.components ?? []).some((c) => c.name === "VAT" && c.rateBps === 2000),
);
const destBiz = await getBusinessByPublicId(orgId, dest.publicId);
ok(
  "T1: the source prefix is NOT copied (the destination keeps its own)",
  destBiz?.invoicePrefix !== "SRC" && destBiz?.invoicePrefix === dest.invoicePrefix,
);
ok("T1: settings due-days copied", destBiz?.defaultDueDays === 15);
ok("T1: report counts catalog created", (job.report as any)?.catalog?.created >= 2);

// ── T2: re-run merges (update, no dup) ─────────────────────────────────────────
const priceRow = (
  await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(products)
      .where(and(eq(products.businessId, src.id), eq(products.publicId, "pro")))
      .limit(1),
  )
)[0]!;
await createPrice({
  organizationId: orgId,
  businessId: src.id,
  productId: priceRow.id,
  id: "pro-yearly",
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 100000,
  interval: "year",
});
const job2 = await runTransfer({
  organizationId: orgId,
  sourceBusinessId: src.id,
  destinationBusinessId: dest.id,
});
const destPrices2 = await listPrices(orgId, dest.id);
ok(
  "T2: re-run added the new price",
  destPrices2.some((p) => p.price.publicId === "pro-yearly"),
);
ok(
  "T2: re-run did NOT duplicate the product",
  (await listProducts(orgId, dest.id)).filter((p) => p.publicId === "pro").length === 1,
);
ok("T2: re-run reports updates", (job2.report as any)?.catalog?.updated >= 1);

// ── T3: destination LIVE = merge-only (wipe ignored, pre-existing survives) ─────
const liveDest = await createBusiness({
  organizationId: orgId,
  name: "LiveDest",
  defaultCurrency: "USD",
  livemode: "live",
});
await createProduct({
  organizationId: orgId,
  businessId: liveDest.id,
  name: "Legacy",
  id: "legacy",
  kind: "plan",
});
const liveJob = await runTransfer({
  organizationId: orgId,
  sourceBusinessId: src.id,
  destinationBusinessId: liveDest.id,
  wipeDestination: true,
});
ok("T3: wipe_destination ignored on a LIVE destination", liveJob.wipeDestination === false);
const liveProducts = await listProducts(orgId, liveDest.id);
ok(
  "T3: pre-existing live object survives (merge-only)",
  liveProducts.some((p) => p.publicId === "legacy"),
);
ok(
  "T3: source object also merged in",
  liveProducts.some((p) => p.publicId === "pro"),
);

// ── T3b (H-review blocker regression): LIVE collision = SKIP, never overwrite ──
// The live dest now has 'pro'/'pro-monthly' (copied above at 10000). Change the
// SOURCE price + settings, re-transfer: the LIVE rows must be untouched.
{
  const srcPro = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(products)
        .where(and(eq(products.businessId, src.id), eq(products.publicId, "pro")))
        .limit(1),
    )
  )[0]!;
  const { prices: pricesTable, businesses: bizTable, auditLogs } = await import("@db/schema");
  await withTenant(orgId, (tx) =>
    tx
      .update(pricesTable)
      .set({ amountMinor: 99900n })
      .where(and(eq(pricesTable.businessId, src.id), eq(pricesTable.publicId, "pro-monthly"))),
  );
  await updateBusiness(orgId, src.publicId, { invoicePrefix: "HACK" });
  const liveBefore = await getBusinessByPublicId(orgId, liveDest.publicId);
  const job3b = await runTransfer({
    organizationId: orgId,
    sourceBusinessId: src.id,
    destinationBusinessId: liveDest.id,
  });
  ok("T3b: live re-transfer succeeded", job3b.status === "succeeded");
  const livePrice = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(pricesTable)
        .where(
          and(eq(pricesTable.businessId, liveDest.id), eq(pricesTable.publicId, "pro-monthly")),
        )
        .limit(1),
    )
  )[0]!;
  ok(
    "T3b: LIVE price NOT overwritten on collision (still 10000, not 99900)",
    livePrice.amountMinor === 10000n,
  );
  const liveAfter = await getBusinessByPublicId(orgId, liveDest.publicId);
  ok(
    "T3b: LIVE settings NOT overwritten",
    liveAfter?.defaultDueDays === liveBefore?.defaultDueDays && liveAfter?.defaultDueDays !== 15,
  );
  ok(
    "T3b: collisions reported as skipped",
    ((job3b.report as any)?.catalog?.skipped ?? 0) >= 1 &&
      ((job3b.report as any)?.settings?.skipped ?? 0) >= 1,
  );
  const audits = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, liveDest.id), eq(auditLogs.action, "transfer.run"))),
  );
  ok("T3b: transfer writes an audit_logs row", audits.length >= 1);
  void srcPro;
  void bizTable;
}

// ── T4: never copies customers/subscriptions ───────────────────────────────────
await createCustomer({ organizationId: orgId, businessId: src.id, email: "c@src.com" });
await runTransfer({
  organizationId: orgId,
  sourceBusinessId: src.id,
  destinationBusinessId: dest.id,
});
const destCustomers = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.businessId, dest.id)),
);
ok("T4: customers are NEVER copied", destCustomers.length === 0);

// ── T5: sample data create + delete ────────────────────────────────────────────
const sampleBiz = await createBusiness({
  organizationId: orgId,
  name: "Sandbox",
  defaultCurrency: "USD",
  livemode: "test",
});
const created = await createSampleData(orgId, sampleBiz.id);
ok(
  "T5: sample_data created products",
  created.products === 2 &&
    (await listProducts(orgId, sampleBiz.id)).some((p) => p.publicId === "sample-plan"),
);
const deleted = await deleteSampleData(orgId, sampleBiz.id);
ok(
  "T5: sample_data deleted",
  deleted.products === 2 &&
    (await listProducts(orgId, sampleBiz.id)).every((p) => p.publicId !== "sample-plan"),
);

// ── helpers for T6+ ────────────────────────────────────────────────────────────
type BizRow = typeof businesses.$inferSelect;
const rowIn = async (org: string, id: string): Promise<BizRow> =>
  (await withTenant(org, (tx) => tx.select().from(businesses).where(eq(businesses.id, id))))[0]!;
const row = (id: string) => rowIn(orgId, id);
const setBiz = (id: string, set: Partial<typeof businesses.$inferInsert>, org = orgId) =>
  withTenant(org, (tx) => tx.update(businesses).set(set).where(eq(businesses.id, id)));
const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );
const pair = (s: { id: string }, d: { id: string }) => ({
  organizationId: orgId,
  sourceBusinessId: s.id,
  destinationBusinessId: d.id,
});
const ALL6 = [
  "catalog",
  "coupons",
  "tax_rates",
  "settings",
  "company_profile",
  "email_sending",
] as const;

// ── T6: prefixes ───────────────────────────────────────────────────────────────
{
  const before = await row(dest.id);
  await runTransfer({ ...pair(src, dest), sections: ["settings"] });
  ok(
    "T6: with no numbering the destination keeps its prefixes",
    (await row(dest.id)).invoicePrefix === before.invoicePrefix,
  );
  const set = await runTransfer({
    ...pair(src, dest),
    sections: ["settings"],
    numbering: { invoicePrefix: "DST", creditNotePrefix: "DSTCN" },
  });
  const after = await row(dest.id);
  ok(
    "T6: numbering sets both prefixes",
    set.status === "succeeded" &&
      after.invoicePrefix === "DST" &&
      after.creditNotePrefix === "DSTCN",
  );
  // `src` (test) uses HACK since T3b.
  const clash = await err(
    runTransfer({
      ...pair(src, dest),
      sections: ["settings"],
      numbering: { invoicePrefix: "HACK" },
    }),
  );
  ok(
    "T6: a prefix another business uses is refused",
    clash instanceof TransferError && /already in use/.test((clash as Error).message),
  );
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: sampleBiz.id,
    email: "numbers@example.com",
  });
  await withTenant(orgId, (tx) =>
    tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: sampleBiz.id,
        customerId: cust.id,
        publicId: publicId("inv"),
        number: "OLD-7",
        currency: "USD",
        subtotalMinor: 0n,
        totalMinor: 0n,
      }),
  );
  const issued = await err(
    runTransfer({
      ...pair(src, dest),
      sections: ["settings"],
      numbering: { invoicePrefix: "OLD" },
    }),
  );
  ok(
    "T6: a prefix whose numbers another business issued is refused",
    issued instanceof TransferError && /start with OLD-/.test((issued as Error).message),
  );
  ok("T6: a refused run writes nothing", (await row(dest.id)).invoicePrefix === "DST");
}

// ── T7: storefront keeps the destination's own URLs ────────────────────────────
{
  await setBiz(src.id, {
    storefrontConfig: {
      collect_po_number: true,
      default_return_url: "https://src.example/thanks",
      default_cancel_url: "https://src.example/cancel",
      portal_link_error_html: "<p>Ask Source.</p>",
    },
  });
  await setBiz(dest.id, {
    storefrontConfig: { default_return_url: "https://dest.example/thanks" },
  });
  await runTransfer({ ...pair(src, dest), sections: ["settings"] });
  const sf = ((await row(dest.id)).storefrontConfig ?? {}) as Record<string, unknown>;
  ok(
    "T7: the destination keeps its own return URL",
    sf.default_return_url === "https://dest.example/thanks",
  );
  ok("T7: the source cancel URL is not copied", !("default_cancel_url" in sf));
  ok("T7: the source portal error text is not copied", !("portal_link_error_html" in sf));
  ok("T7: the other storefront settings are copied", sf.collect_po_number === true);
}

// ── T8: the live guard ─────────────────────────────────────────────────────────
const SECRET = "smtp-pass-7f3a9c";
await setBiz(src.id, {
  address: {
    line1: "1 Test Street",
    city: "Chennai",
    state: "TN",
    postal_code: "600001",
    country: "IN",
  },
  taxRegistrationNumber: "33AAAAA0000A1Z5",
  defaultTaxCode: "998314",
  defaultDueDays: 21,
  emailConfig: {
    enabled: true,
    fromName: "Source Billing",
    fromAddress: "billing@src.example",
    subjectPrefix: "[Source]",
    footerNote: "Thanks, Source",
  },
});
await saveSmtpSettings(orgId, src.id, {
  enabled: true,
  host: "smtp.src.example",
  port: 587,
  encryption: "starttls",
  username: "mailer",
  password: SECRET,
});
const toLive = { ...pair(src, liveDest), sections: [...ALL6] };
const liveJobs = async () =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transferConfigurations)
        .where(eq(transferConfigurations.destinationBusinessId, liveDest.id)),
    )
  ).length;
{
  const before = await row(liveDest.id);
  const plain = await runTransfer(toLive);
  const after = await row(liveDest.id);
  const kept = (
    [
      "address",
      "taxRegistrationNumber",
      "defaultTaxCode",
      "defaultDueDays",
      "emailConfig",
      "smtpConfig",
      "smtpCredentialsEnc",
    ] as const
  ).every((k) => JSON.stringify(after[k]) === JSON.stringify(before[k]));
  ok(
    "T8: without the override a live destination keeps profile, settings and email",
    plain.status === "succeeded" && kept,
  );
  const r = plain.report as any;
  ok(
    "T8: the held-back sections are reported as skipped",
    r?.settings?.skipped === 1 &&
      r?.company_profile?.skipped === 1 &&
      r?.email_sending?.skipped === 1,
  );

  const pv = await previewTransfer(toLive);
  const lo = { confirm: "LiveDest", planDigest: pv.plan_digest };
  const jobs0 = await liveJobs();
  ok(
    "T8: a key (no person) cannot grant the override",
    (await err(runTransfer({ ...toLive, liveOverride: lo, operatorRole: null }))) instanceof
      TransferForbiddenError,
  );
  for (const role of ["manager", "ops", "developer"] as const)
    ok(
      `T8: a ${role} cannot grant the override`,
      (await err(runTransfer({ ...toLive, liveOverride: lo, operatorRole: role }))) instanceof
        TransferForbiddenError,
    );
  ok(
    "T8: a confirmation that is not the exact name is refused",
    (await err(
      runTransfer({
        ...toLive,
        liveOverride: { ...lo, confirm: "livedest" },
        operatorRole: "owner",
      }),
    )) instanceof TransferError,
  );
  ok(
    "T8: the override on a test destination is refused",
    (await err(
      runTransfer({
        ...pair(src, dest),
        liveOverride: { confirm: "Dest", planDigest: "x" },
        operatorRole: "owner",
      }),
    )) instanceof TransferError,
  );
  await setBiz(liveDest.id, { defaultDueDays: 9 });
  ok(
    "T8: a preview the destination changed after is refused (409)",
    (await err(runTransfer({ ...toLive, liveOverride: lo, operatorRole: "owner" }))) instanceof
      TransferConflictError,
  );
  const now = await row(liveDest.id);
  ok(
    "T8: refused runs create no job and change nothing",
    (await liveJobs()) === jobs0 &&
      now.defaultDueDays === 9 &&
      JSON.stringify(now.emailConfig) === JSON.stringify(before.emailConfig),
  );
  ok(
    "T8: test twins need two live businesses",
    (await err(runTransfer({ ...pair(src, dest), includeTestTwins: true }))) instanceof
      TransferError,
  );
}

// ── T9: the live override ──────────────────────────────────────────────────────
{
  const pv = await previewTransfer(toLive);
  const pvJson = JSON.stringify(pv);
  const srcRow = await row(src.id);
  ok("T9: the preview offers the live override", pv.live_override_available === true);
  ok(
    "T9: the preview carries no secret and no envelope",
    !pvJson.includes(SECRET) && !pvJson.includes(srcRow.smtpCredentialsEnc!),
  );
  const smtpField = pv.pairs[0]!.sections.find((s) => s.section === "email_sending")?.fields?.find(
    (f) => f.field === "smtp_credentials",
  );
  ok("T9: the preview masks the secret", smtpField?.to === "••••" && smtpField.changed === true);
  const job = await runTransfer({
    ...toLive,
    liveOverride: { confirm: "LiveDest", planDigest: pv.plan_digest },
    operatorRole: "admin",
  });
  ok(
    "T9: the override run succeeded and is marked",
    job.status === "succeeded" && job.liveOverride === true && job.planDigest === pv.plan_digest,
  );
  const L = await row(liveDest.id);
  ok(
    "T9: company profile written",
    L.taxRegistrationNumber === "33AAAAA0000A1Z5" && L.defaultTaxCode === "998314",
  );
  ok("T9: settings written", L.defaultDueDays === 21);
  const ec = (L.emailConfig ?? {}) as Record<string, unknown>;
  ok(
    "T9: sender details written, brand text not",
    ec.fromAddress === "billing@src.example" && !("subjectPrefix" in ec) && !("footerNote" in ec),
  );
  ok(
    "T9: the SMTP password decrypts to the source one on the destination",
    readSmtpPassword(L.smtpCredentialsEnc) === SECRET,
  );
  const { prices: pricesTable } = await import("@db/schema");
  const livePrice = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(pricesTable)
        .where(
          and(eq(pricesTable.businessId, liveDest.id), eq(pricesTable.publicId, "pro-monthly")),
        )
        .limit(1),
    )
  )[0]!;
  ok(
    "T9: catalog stays merge-only under the override (live price still 10000)",
    livePrice.amountMinor === 10000n,
  );
  const [audit] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "transfer.live_override"), eq(auditLogs.resourceId, job.id))),
  );
  const a = audit as any;
  ok(
    "T9: the audit row records each field before and after",
    a?.before?.fields?.default_due_days === 9 &&
      a?.after?.fields?.default_due_days === 21 &&
      a?.after?.plan_digest === pv.plan_digest,
  );
  const auditJson = JSON.stringify(audit ?? {});
  ok(
    "T9: the audit row carries no secret and no envelope",
    !!audit &&
      !auditJson.includes(SECRET) &&
      !auditJson.includes(L.smtpCredentialsEnc!) &&
      a.after.fields.smtp_credentials_enc === "••••",
  );
  const again = await previewTransfer(toLive);
  ok(
    "T9: a second preview shows nothing to change",
    again.pairs[0]!.sections.every((s) => s.changes === 0),
  );
  await runTransfer({
    ...toLive,
    liveOverride: { confirm: "LiveDest", planDigest: again.plan_digest },
    operatorRole: "owner",
  });
  ok(
    "T9: a re-run keeps the destination envelope",
    (await row(liveDest.id)).smtpCredentialsEnc === L.smtpCredentialsEnc,
  );
}

// ── T10: tax on a live destination ─────────────────────────────────────────────
{
  const vatOf = async (bizId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(taxRateComponents)
          .where(and(eq(taxRateComponents.businessId, bizId), eq(taxRateComponents.name, "VAT"))),
      )
    )[0]!;
  const liveVat = await vatOf(liveDest.id);
  const buyer = await createCustomer({
    organizationId: orgId,
    businessId: liveDest.id,
    email: "buyer@example.com",
  });
  const applied = async (componentId: string, name: string) => {
    const [inv] = await withTenant(orgId, (tx) =>
      tx
        .insert(invoices)
        .values({
          organizationId: orgId,
          businessId: liveDest.id,
          customerId: buyer.id,
          publicId: publicId("inv"),
          currency: "USD",
          subtotalMinor: 1000n,
          totalMinor: 1200n,
        })
        .returning(),
    );
    const [line] = await withTenant(orgId, (tx) =>
      tx
        .insert(invoiceLineItems)
        .values({
          publicId: publicId("il"),
          organizationId: orgId,
          businessId: liveDest.id,
          invoiceId: inv!.id,
          description: "Pro",
          kind: "recurring",
          quantity: 1,
          unitAmountMinor: 1000n,
          amountMinor: 1000n,
        })
        .returning(),
    );
    const [at] = await withTenant(orgId, (tx) =>
      tx
        .insert(appliedTaxes)
        .values({
          organizationId: orgId,
          businessId: liveDest.id,
          invoiceId: inv!.id,
          invoiceLineItemId: line!.id,
          taxComponentId: componentId,
          name,
          rateBps: 2000,
          amountMinor: 200n,
        })
        .returning(),
    );
    return at!;
  };
  const issued = await applied(liveVat.id, "VAT");
  await withTenant(orgId, async (tx) =>
    tx
      .update(taxRateComponents)
      .set({ rateBps: 2100 })
      .where(eq(taxRateComponents.id, (await vatOf(src.id)).id)),
  );
  const pv = await previewTransfer(toLive);
  ok(
    "T10: the preview shows the tax change",
    (pv.pairs[0]!.sections.find((s) => s.section === "tax_rates")?.changes ?? 0) > 0,
  );
  const job = await runTransfer({
    ...toLive,
    liveOverride: { confirm: "LiveDest", planDigest: pv.plan_digest },
    operatorRole: "owner",
  });
  const after = await vatOf(liveDest.id);
  ok(
    "T10: the live component is updated in place",
    job.status === "succeeded" && after.id === liveVat.id && after.rateBps === 2100,
  );
  const link = (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedTaxes).where(eq(appliedTaxes.id, issued.id)),
    )
  )[0]!;
  ok("T10: the issued invoice keeps its tax link", link.taxComponentId === liveVat.id);

  // A destination-only component that an issued invoice uses cannot be removed.
  const extra = (
    await withTenant(orgId, (tx) =>
      tx
        .insert(taxRateComponents)
        .values({
          organizationId: orgId,
          businessId: liveDest.id,
          taxRegionId: liveVat.taxRegionId,
          publicId: publicId("txc"),
          name: "Extra",
          rateBps: 100,
        })
        .returning(),
    )
  )[0]!;
  await applied(extra.id, "Extra");
  const blocked = await previewTransfer(toLive);
  ok(
    "T10: the preview shows the blocker",
    blocked.pairs[0]!.blockers.some(
      (b) => b.section === "tax_rates" && b.message.includes("Extra"),
    ),
  );
  const refused = await err(
    runTransfer({
      ...toLive,
      liveOverride: { confirm: "LiveDest", planDigest: blocked.plan_digest },
      operatorRole: "owner",
    }),
  );
  ok("T10: the run is refused", refused instanceof TransferError);
  const stillLinked = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(appliedTaxes)
      .where(and(eq(appliedTaxes.businessId, liveDest.id), isNotNull(appliedTaxes.taxComponentId))),
  );
  ok("T10: no issued tax line was detached", stillLinked.length === 2);

  // An empty default profile on the destination is renamed in place, not duplicated.
  const dest2 = await createBusiness({
    organizationId: orgId,
    name: "Dest2",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const [main] = await withTenant(orgId, (tx) =>
    tx
      .insert(taxProfiles)
      .values({
        organizationId: orgId,
        businessId: dest2.id,
        publicId: publicId("txp"),
        name: "Main",
        isDefault: true,
      })
      .returning(),
  );
  const srcDefault = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(taxProfiles)
        .where(and(eq(taxProfiles.businessId, src.id), eq(taxProfiles.isDefault, true))),
    )
  )[0]!;
  const j2 = await runTransfer({ ...pair(src, dest2), sections: ["tax_rates"] });
  const profiles2 = await withTenant(orgId, (tx) =>
    tx.select().from(taxProfiles).where(eq(taxProfiles.businessId, dest2.id)),
  );
  const renamed = profiles2.find((p) => p.id === main!.id);
  ok(
    "T10: an empty default profile is renamed in place",
    j2.status === "succeeded" &&
      renamed?.name === srcDefault.name &&
      profiles2.filter((p) => p.isDefault).length === 1,
  );
  const regions2 = await withTenant(orgId, (tx) =>
    tx.select().from(taxRegions).where(eq(taxRegions.taxProfileId, main!.id)),
  );
  ok("T10: the renamed profile holds the copied regions", regions2.length >= 1);
}

// ── T11: test twins ────────────────────────────────────────────────────────────
{
  const liveA = await createBusiness({
    organizationId: orgId,
    name: "Live A",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const liveB = await createBusiness({
    organizationId: orgId,
    name: "Live B",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const twinOf = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(businesses).where(eq(businesses.liveBusinessId, id)),
      )
    )[0];
  const twinA = await twinOf(liveA.id);
  const twinB = await twinOf(liveB.id);
  ok("T11: fixture — both live businesses have a test twin", !!twinA && !!twinB);
  if (twinA && twinB) {
    await setBiz(liveA.id, { defaultDueDays: 30 });
    await setBiz(twinA.id, { defaultDueDays: 7 });
    const AB = { ...pair(liveA, liveB), sections: ["settings" as const], includeTestTwins: true };
    const pv = await previewTransfer(AB);
    ok(
      "T11: the preview covers both pairs, test first",
      pv.pairs.length === 2 && pv.pairs[0]!.destination_livemode === "test",
    );
    const jt = await runTransfer({
      ...AB,
      liveOverride: { confirm: "Live B", planDigest: pv.plan_digest },
      operatorRole: "owner",
    });
    ok(
      "T11: one run copies both pairs",
      jt.status === "succeeded" && jt.twin?.status === "succeeded" && jt.twin?.twinOf === jt.id,
    );
    ok(
      "T11: each pair reads its own source",
      (await row(twinB.id)).defaultDueDays === 7 && (await row(liveB.id)).defaultDueDays === 30,
    );

    await setBiz(sampleBiz.id, { invoicePrefix: "TWN" });
    await setBiz(liveA.id, { defaultDueDays: 45 });
    const blocked = { ...AB, numbering: { invoicePrefix: "TWN" } };
    const pvB = await previewTransfer(blocked);
    ok(
      "T11: the preview shows the twin blocker only",
      pvB.pairs[0]!.blockers.length > 0 && pvB.pairs[1]!.blockers.length === 0,
    );
    const refused = await err(
      runTransfer({
        ...blocked,
        liveOverride: { confirm: "Live B", planDigest: pvB.plan_digest },
        operatorRole: "owner",
      }),
    );
    ok("T11: a blocked twin refuses the run", refused instanceof TransferError);
    ok("T11: the live business is not changed", (await row(liveB.id)).defaultDueDays === 30);
  }
}

// ── T13: clear-first preview, tagged blockers, one run at a time, history ──────
{
  // Clear-first: the preview counts what is deleted, and the run deletes it.
  const clearDest = await createBusiness({
    organizationId: orgId,
    name: "ClearDest",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createProduct({
    organizationId: orgId,
    businessId: clearDest.id,
    name: "Old",
    id: "old-only",
    kind: "plan",
  });
  const pvc = await previewTransfer({
    ...pair(src, clearDest),
    sections: ["catalog"],
    wipeDestination: true,
  });
  const cat = pvc.pairs[0]!.sections.find((x) => x.section === "catalog");
  ok(
    "T13: the preview shows a clear-first and what it deletes",
    pvc.pairs[0]!.clear_first === true &&
      (cat?.objects?.deleted ?? 0) >= 1 &&
      cat?.objects?.existing === 0,
  );
  const jc = await runTransfer({
    ...pair(src, clearDest),
    sections: ["catalog"],
    wipeDestination: true,
  });
  const left = await listProducts(orgId, clearDest.id);
  ok(
    "T13: the clear-first run deletes and copies",
    jc.status === "succeeded" &&
      !left.some((p) => p.publicId === "old-only") &&
      left.some((p) => p.publicId === "pro"),
  );

  // Blockers name their section, so a caller can leave that section out.
  const pvn = await previewTransfer({
    ...pair(src, dest),
    sections: ["settings"],
    numbering: { invoicePrefix: "HACK" },
  });
  ok(
    "T13: a blocker names its section",
    pvn.pairs[0]!.blockers.length > 0 &&
      pvn.pairs[0]!.blockers.every((b) => b.section === "numbering"),
  );

  // One run per destination at a time; a run older than the reaper cutoff does not count.
  const [held] = await withTenant(orgId, (tx) =>
    tx
      .insert(transferConfigurations)
      .values({
        organizationId: orgId,
        sourceBusinessId: src.id,
        destinationBusinessId: clearDest.id,
        sections: ["catalog"],
        status: "running",
      })
      .returning(),
  );
  const busy = await err(runTransfer({ ...pair(src, clearDest), sections: ["catalog"] }));
  ok(
    "T13: a second run into a busy destination is refused (409)",
    busy instanceof TransferConflictError,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(transferConfigurations)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(transferConfigurations.id, held!.id)),
  );
  const after = await runTransfer({ ...pair(src, clearDest), sections: ["catalog"] });
  ok("T13: a crashed run does not block a new one", after.status === "succeeded");

  // History: newest first, per business or the whole organization, twins nested, paged.
  const mine = await listTransfers(orgId, { businessId: clearDest.id, limit: 50 });
  ok(
    "T13: history of a business lists only its runs, newest first",
    mine.data.length >= 2 &&
      mine.data.every(
        (j) => j.destinationBusinessId === clearDest.id || j.sourceBusinessId === clearDest.id,
      ) &&
      mine.data[0]!.id === after.id,
  );
  const org = await listTransfers(orgId, { limit: 100 });
  ok(
    "T13: organization history has every main run and no twin rows on top",
    org.data.some((j) => j.destinationBusinessId === liveDest.id) &&
      org.data.every((j) => j.twinOf === null),
  );
  ok(
    "T13: a run with twins carries its twin",
    org.data.some((j) => j.twin && j.twin.twinOf === j.id),
  );
  const p1 = await listTransfers(orgId, { limit: 1 });
  const p2 = await listTransfers(orgId, { limit: 1, startingAfter: p1.data[0]!.id });
  ok(
    "T13: history pages with a cursor",
    p1.hasMore && p2.data.length === 1 && p2.data[0]!.id !== p1.data[0]!.id,
  );
}

// ── T12: over HTTP ─────────────────────────────────────────────────────────────
{
  const app = await buildApp({ logger: false });
  const PW = "Correct-Horse-Battery-9";
  const uniq = randomBytes(4).toString("hex");
  const em = (r: string) => `transfer-${r}-${uniq}@example.com`;
  const owner = await signup({
    email: em("owner"),
    password: PW,
    organizationName: `Transfer HTTP ${uniq}`,
  });
  const hOrg = owner.user.organizationId;
  const hSrc = await createBusiness({
    organizationId: hOrg,
    name: "H Source",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const hDest = await createBusiness({
    organizationId: hOrg,
    name: "H Dest",
    defaultCurrency: "USD",
    livemode: "live",
  });
  await setBiz(hSrc.id, { defaultDueDays: 12 }, hOrg);
  const sessionAs = async (role: "admin" | "manager"): Promise<string> => {
    const invited = await inviteUser({ organizationId: hOrg, email: em(role), role });
    const tok = `invt_${randomBytes(32).toString("base64url")}`;
    await systemDb
      .insert(authTokens)
      .values({
        userId: invited.userId,
        tokenHash: createHash("sha256").update(tok).digest("hex"),
        purpose: "invite",
        expiresAt: new Date(Date.now() + 3600_000),
      });
    return (await acceptInvite(tok, PW)).token;
  };
  const call = (url: string, auth: { cookie?: string; bearer?: string }, payload: object) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...(auth.cookie
          ? { cookie: `tmb_session=${auth.cookie}` }
          : { authorization: `Bearer ${auth.bearer}` }),
        "idempotency-key": randomBytes(8).toString("hex"),
      },
      payload,
    });
  const url = `/v1/businesses/${hSrc.publicId}/transfer_configurations`;
  const body = { destination_business: hDest.publicId, sections: ["settings"] };
  const pvRes = await call(`${url}/preview`, { cookie: owner.token }, body);
  ok(
    "T12: preview answers 200 with a digest",
    pvRes.statusCode === 200 && typeof pvRes.json().plan_digest === "string",
  );
  const lo = { confirm: "H Dest", plan_digest: pvRes.json().plan_digest };
  const byKey = await call(
    url,
    { bearer: owner.dashboardKeySecret },
    { ...body, live_override: lo },
  );
  ok(
    "T12: a key cannot grant the live override (403)",
    byKey.statusCode === 403 && /live override/.test(byKey.json().error?.message ?? ""),
  );
  const mgr = await call(
    url,
    { cookie: await sessionAs("manager") },
    { ...body, live_override: lo },
  );
  ok("T12: a manager session is refused (403)", mgr.statusCode === 403);
  const admin = await sessionAs("admin");
  const wrong = await call(
    url,
    { cookie: admin },
    { ...body, live_override: { ...lo, confirm: "H dest" } },
  );
  ok("T12: a wrong confirmation answers 400", wrong.statusCode === 400);
  await setBiz(hDest.id, { defaultDueDays: 3 }, hOrg);
  const stale = await call(url, { cookie: admin }, { ...body, live_override: lo });
  ok("T12: a stale preview answers 409", stale.statusCode === 409);
  const fresh = (await call(`${url}/preview`, { cookie: admin }, body)).json();
  const good = await call(
    url,
    { cookie: admin },
    { ...body, live_override: { confirm: "H Dest", plan_digest: fresh.plan_digest } },
  );
  ok(
    "T12: an admin with a fresh preview and the exact name gets 201",
    good.statusCode === 201 && good.json().live_override === true,
  );
  ok(
    "T12: the live destination took the setting",
    (await rowIn(hOrg, hDest.id)).defaultDueDays === 12,
  );
  const plain = await call(url, { bearer: owner.dashboardKeySecret }, body);
  ok(
    "T12: a key still runs a plain transfer (201, no override)",
    plain.statusCode === 201 && plain.json().live_override === false,
  );
  const hist = await app.inject({
    method: "GET",
    url: `${url}?limit=1`,
    headers: { cookie: `tmb_session=${admin}` },
  });
  const hj = hist.json();
  ok(
    "T12: history answers a list with a cursor",
    hist.statusCode === 200 &&
      hj.object === "list" &&
      hj.data.length === 1 &&
      hj.has_more === true &&
      typeof hj.next_cursor === "string",
  );
  await app.close();
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ TRANSFER: PASS" : `❌ TRANSFER: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
