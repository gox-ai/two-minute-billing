/**
 * The three file-import jobs: `import_check` (parse and check every row, write the summary),
 * `import_run` (adopt what is there, then the migration engine), `import_undo`.
 *
 * The run job is safe to repeat: the engine skips every source id it imported before, so a
 * crashed run that is queued again continues where it stopped. A lease keeps it single.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import {
  businesses,
  coupons,
  gatewayAccounts,
  importRows,
  importRuns,
  prices,
  products,
  subscriptions,
  users,
} from "@db/schema";
import { writeAuditLog } from "@/modules/audit/service";
import { getTestBusinessUsage } from "@/modules/tenancy/test-limits";
import { importFromSource, type ImportRecordOutcome } from "@/modules/migration/import";
import {
  analyze,
  type CheckContext,
  type ExistingPrice,
  type RawRow,
  type RowResult,
  type RunFile,
  type RunOptions,
} from "./check";
import { StagedSource, type StagedInput, type StagedRow } from "./source";
import { HISTORY_ENTITIES, IMPORT_ENTITIES, type ImportEntity } from "./templates";
import type { RunRow } from "./runs";
import { performUndo, UndoRefusedError } from "./undo";

const log = createLogger("bulk-import");

/** A heartbeat older than this means the runner died; the clock queues the run again. */
export const LEASE_STALE_MS = 5 * 60_000;
/** How often a running import writes its heartbeat and progress. */
const PROGRESS_MS = 2_000;
const ROW_UPDATE_CHUNK = 1000;

async function loadRun(runId: string): Promise<RunRow | null> {
  const [r] = await systemDb.select().from(importRuns).where(eq(importRuns.id, runId));
  return r ?? null;
}

async function loadContext(
  tx: Tx,
  org: string,
  businessId: string,
  now: Date,
  sourceName: string,
): Promise<CheckContext> {
  const [biz] = await tx
    .select({ timezone: businesses.timezone, invoiceNextNumber: businesses.invoiceNextNumber })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  const priceRows = await tx
    .select({
      id: prices.publicId,
      currency: prices.currency,
      model: prices.model,
      amountMinor: prices.amountMinor,
      interval: prices.interval,
      intervalCount: prices.intervalCount,
      kind: products.kind,
    })
    .from(prices)
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(prices.businessId, businessId));
  const existingPrices = new Map<string, ExistingPrice>();
  for (const p of priceRows)
    existingPrices.set(p.id, {
      currency: p.currency,
      model: p.model,
      amountMinor: p.amountMinor == null ? null : Number(p.amountMinor),
      interval: p.interval,
      intervalCount: p.intervalCount,
      kind: (p.kind as ExistingPrice["kind"]) ?? "plan",
    });
  const productIds = await tx
    .select({ id: products.publicId })
    .from(products)
    .where(eq(products.businessId, businessId));
  const couponIds = await tx
    .select({ id: coupons.code })
    .from(coupons)
    .where(eq(coupons.businessId, businessId));
  const customerRows = (await tx.execute(sql`
    select c.public_id as id,
           exists (select 1 from payment_methods pm where pm.customer_id = c.id and pm.status = 'valid') as has_card
      from customers c where c.business_id = ${businessId}::uuid`)) as unknown as Array<{
    id: string;
    has_card: boolean;
  }>;
  const subIds = await tx
    .select({ id: subscriptions.publicId })
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId));
  const items = (await tx.execute(sql`
    select s.public_id as sub, p.public_id as price
      from subscription_items i
      join subscriptions s on s.id = i.subscription_id
      join prices p on p.id = i.price_id
     where s.business_id = ${businessId}::uuid`)) as unknown as Array<{
    sub: string;
    price: string;
  }>;
  const subscriptionPrices = new Map<string, Set<string>>();
  for (const r of items) {
    const set = subscriptionPrices.get(r.sub) ?? new Set<string>();
    set.add(r.price);
    subscriptionPrices.set(r.sub, set);
  }
  // History an earlier file import into this business brought, by source id.
  const records = (await tx.execute(sql`
    select r.source_type, r.source_id, i.currency, c.public_id as customer
      from import_records r
      left join invoices i on r.source_type = 'invoice' and i.id = r.target_id
      left join customers c on c.id = i.customer_id
     where r.business_id = ${businessId}::uuid and r.source = ${sourceName}
       and r.source_type in ('invoice', 'credit_note', 'transaction', 'usage_record')`)) as unknown as Array<{
    source_type: string;
    source_id: string;
    currency: string | null;
    customer: string | null;
  }>;
  const imported = {
    invoices: new Map<string, { currency: string; customerId: string | null }>(),
    creditNotes: new Set<string>(),
    transactions: new Set<string>(),
    usage: new Set<string>(),
  };
  for (const r of records) {
    if (r.source_type === "invoice")
      imported.invoices.set(r.source_id, { currency: r.currency ?? "", customerId: r.customer });
    else if (r.source_type === "credit_note") imported.creditNotes.add(r.source_id);
    else if (r.source_type === "transaction") imported.transactions.add(r.source_id);
    else imported.usage.add(r.source_id);
  }
  const gateways = await tx
    .select({ key: gatewayAccounts.gatewayKey })
    .from(gatewayAccounts)
    .where(and(eq(gatewayAccounts.businessId, businessId), eq(gatewayAccounts.status, "active")));
  return {
    tz: biz?.timezone ?? null,
    now,
    existing: {
      prices: existingPrices,
      products: new Set(productIds.map((r) => r.id)),
      coupons: new Set(couponIds.map((r) => r.id)),
      customers: new Map(customerRows.map((r) => [r.id, r.has_card])),
      subscriptions: new Set(subIds.map((r) => r.id)),
      subscriptionPrices,
      imported,
    },
    invoiceNextNumber: biz?.invoiceNextNumber == null ? null : Number(biz.invoiceNextNumber),
    connectedGateways: new Set(gateways.map((g) => g.key)),
    testUsage: await getTestBusinessUsage(org, businessId),
  };
}

async function loadRawRows(tx: Tx, runId: string): Promise<RawRow[]> {
  const rows = await tx
    .select({
      id: importRows.id,
      entity: importRows.entity,
      rowNumber: importRows.rowNumber,
      raw: importRows.raw,
    })
    .from(importRows)
    .where(eq(importRows.runId, runId))
    // File order: the check's "first row wins" and a subscription's item order follow it.
    .orderBy(importRows.entity, importRows.rowNumber);
  return rows.map((r) => ({
    ...r,
    entity: r.entity as ImportEntity,
    raw: r.raw as Record<string, string>,
  }));
}

async function storeRowResults(tx: Tx, runId: string, rows: RowResult[]) {
  for (let i = 0; i < rows.length; i += ROW_UPDATE_CHUNK) {
    const chunk = rows.slice(i, i + ROW_UPDATE_CHUNK).map((r) => ({
      id: r.id,
      parsed: r.parsed,
      errors: r.errors,
      warnings: r.warnings,
      state: r.state,
      source_id: r.sourceId,
    }));
    await tx.execute(sql`
      update import_rows r
         set parsed = x.parsed, errors = x.errors, warnings = x.warnings, state = x.state, source_id = x.source_id
        from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
             as x(id uuid, parsed jsonb, errors jsonb, warnings jsonb, state text, source_id text)
       where r.id = x.id and r.run_id = ${runId}::uuid`);
  }
}

/** Parse and check every row against the files and the business, and store the review. */
export async function runCheckJob(runId: string, now = new Date()): Promise<string> {
  const run = await loadRun(runId);
  if (!run || run.status !== "checking") return "not_checking";
  const version = run.updatedAt.toISOString();
  return withTenant(run.organizationId, async (tx) => {
    const ctx = await loadContext(tx, run.organizationId, run.businessId, now, run.sourceName);
    const raw = await loadRawRows(tx, run.id);
    const { rows, summary } = analyze(run.files as RunFile[], raw, run.options as RunOptions, ctx);
    // A re-check queued while this one ran owns the run now.
    const [still] = await tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.id, run.id),
          eq(importRuns.status, "checking"), // Milliseconds: the stored value has microseconds, a JS Date does not.
          sql`date_trunc('milliseconds', ${importRuns.updatedAt}) = ${version}::timestamptz`,
        ),
      )
      .for("update");
    if (!still) return "superseded";
    await storeRowResults(tx, run.id, rows);
    await tx
      .update(importRuns)
      .set({ status: "checked", summary, checkedAt: new Date(), updatedAt: new Date() })
      .where(eq(importRuns.id, run.id));
    return summary.ready ? "ready" : "blocked";
  });
}

const ENTITY_TYPE: Record<ImportEntity, string> = {
  plans: "price",
  addons: "price",
  coupons: "coupon",
  customers: "customer",
  subscriptions: "subscription",
  invoices: "invoice",
  credit_notes: "credit_note",
  payments: "transaction",
  usage: "usage_record",
};

/**
 * Give records that are in the business but were never imported an import record, so the
 * engine maps to them instead of creating a second one. No `run_id`: undo leaves them.
 */
async function adopt(
  tx: Tx,
  run: RunRow,
  type: string,
  table: "prices" | "products" | "customers" | "coupons" | "subscriptions",
  ids: string[],
) {
  if (!ids.length) return;
  const idCol = table === "coupons" ? sql`t.code` : sql`t.public_id`;
  await tx.execute(sql`
    insert into import_records (organization_id, business_id, source, source_type, source_id, target_type, target_id)
    select ${run.organizationId}::uuid, ${run.businessId}::uuid, ${run.sourceName}, ${type}, ${idCol}, ${type}, t.id
      from ${sql.identifier(table)} t
     where t.business_id = ${run.businessId}::uuid and ${idCol} = any(${`{${ids.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(",")}}`}::text[])
    on conflict (organization_id, source, source_type, source_id) do nothing`);
}

async function lease(run: RunRow, token: string, statuses: string[], next: string) {
  return withTenant(run.organizationId, async (tx) => {
    const [r] = await tx
      .update(importRuns)
      .set({
        leaseToken: token,
        heartbeatAt: new Date(),
        leaseCount: sql`${importRuns.leaseCount} + 1`,
        status: next,
        startedAt: sql`coalesce(${importRuns.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importRuns.id, run.id),
          inArray(importRuns.status, statuses),
          or(
            isNull(importRuns.leaseToken),
            lt(importRuns.heartbeatAt, new Date(Date.now() - LEASE_STALE_MS)),
          ),
        ),
      )
      .returning();
    return r ?? null;
  });
}

export async function runImportJob(runId: string): Promise<string> {
  const head = await loadRun(runId);
  if (!head) return "missing";
  const token = randomUUID();
  const run = await lease(head, token, ["queued", "running"], "running");
  if (!run) return "busy_or_done";
  const org = run.organizationId;
  try {
    return await drive(org, run, token);
  } catch (e) {
    log.error(e, { event: "import_run_failed", run: run.id });
    await finish(
      org,
      run,
      token,
      "failed",
      null,
      "We could not finish the import. Try again, or contact support.",
    );
    return "failed";
  }
}

async function drive(org: string, run: RunRow, token: string): Promise<string> {
  // Check again: time has passed since the review, and the business may have changed.
  const now = new Date();
  const checked = await withTenant(org, async (tx) => {
    const ctx = await loadContext(tx, org, run.businessId, now, run.sourceName);
    const raw = await loadRawRows(tx, run.id);
    const out = analyze(run.files as RunFile[], raw, run.options as RunOptions, ctx);
    await storeRowResults(tx, run.id, out.rows);
    return { ...out, raw, ctx };
  });
  const blockers = checked.summary.blockers.filter((b) => b.code !== "nothing_new");
  if (blockers.length) {
    await finish(
      org,
      run,
      token,
      "failed",
      { summary: checked.summary },
      `The business or the date changed after the check: ${blockers.map((b) => b.message).join(" ")}`,
    );
    return "failed";
  }

  const entityOf = new Map(checked.raw.map((r) => [r.id, r.entity]));
  const rowNoOf = new Map(checked.raw.map((r) => [r.id, r.rowNumber]));
  const byEntity = (e: ImportEntity, states: string[]) =>
    checked.rows.filter((r) => entityOf.get(r.id) === e && states.includes(r.state));
  const staged = (e: ImportEntity): StagedRow[] =>
    byEntity(e, ["new"]).map((r) => ({ rowNumber: rowNoOf.get(r.id)!, values: r.parsed }));

  // Subscriptions to import, and what they refer to that is not in the files as new rows.
  const subGroups = new Map<string, StagedRow[]>();
  for (const r of byEntity("subscriptions", ["new"])) {
    const id = String(r.parsed.subscription_id);
    const l = subGroups.get(id) ?? [];
    l.push({ rowNumber: rowNoOf.get(r.id)!, values: r.parsed });
    subGroups.set(id, l);
  }
  const newIds = (e: ImportEntity, key: string) =>
    new Set(byEntity(e, ["new"]).map((r) => String(r.parsed[key])));
  const newPrices = new Set([...newIds("plans", "price_id"), ...newIds("addons", "price_id")]);
  const newCustomers = newIds("customers", "customer_id");
  const newCoupons = newIds("coupons", "coupon_id");
  const refPrices = new Set<string>();
  const refCustomers = new Set<string>();
  const refCoupons = new Set<string>();
  for (const rows of subGroups.values())
    for (const { values: v } of rows) {
      if (!newCustomers.has(String(v.customer_id))) refCustomers.add(String(v.customer_id));
      if (!newPrices.has(String(v.price_id))) refPrices.add(String(v.price_id));
      for (const c of (v.coupon_ids as string[] | null) ?? [])
        if (!newCoupons.has(c)) refCoupons.add(c);
    }

  // History: invoices (rows are lines), and what history rows refer to outside the files.
  const invGroups = new Map<string, StagedRow[]>();
  for (const r of byEntity("invoices", ["new"])) {
    const id = String(r.parsed.invoice_id);
    const l = invGroups.get(id) ?? [];
    l.push({ rowNumber: rowNoOf.get(r.id)!, values: r.parsed });
    invGroups.set(id, l);
  }
  const refSubs = new Set<string>();
  const refInvoices = new Set<string>();
  const invoiceCustomers: Record<string, string> = {};
  for (const r of byEntity("invoices", ["new", "existing"]))
    invoiceCustomers[String(r.parsed.invoice_id)] = String(r.parsed.customer_id);
  for (const [id, e] of checked.ctx.existing.imported?.invoices ?? [])
    if (e.customerId) invoiceCustomers[id] ??= e.customerId;
  const custRef = (id: unknown) => {
    if (id != null && !newCustomers.has(String(id))) refCustomers.add(String(id));
  };
  const subRef = (id: unknown) => {
    if (id != null && !subGroups.has(String(id))) refSubs.add(String(id));
  };
  const priceRef = (id: unknown) => {
    if (id != null && !newPrices.has(String(id))) refPrices.add(String(id));
  };
  for (const rows of invGroups.values())
    for (const { values: v } of rows) {
      custRef(v.customer_id);
      subRef(v.subscription_id);
      priceRef(v.line_price_id);
    }
  for (const e of ["payments", "credit_notes"] as const)
    for (const r of byEntity(e, ["new"])) {
      custRef(r.parsed.customer_id ?? invoiceCustomers[String(r.parsed.invoice_id)]);
      const inv = r.parsed.invoice_id;
      if (inv != null && !invGroups.has(String(inv))) refInvoices.add(String(inv));
    }
  for (const r of byEntity("usage", ["new"])) {
    subRef(r.parsed.subscription_id);
    priceRef(r.parsed.price_id);
  }

  await withTenant(org, async (tx) => {
    await adopt(tx, run, "price", "prices", [...refPrices]);
    await adopt(tx, run, "subscription", "subscriptions", [...refSubs]);
    await adopt(tx, run, "customer", "customers", [...refCustomers]);
    await adopt(tx, run, "coupon", "coupons", [...refCoupons]);
    // A new price whose plan is in the business already: the engine must not create the plan again.
    const planIds = [
      ...byEntity("plans", ["new"]).map((r) => String(r.parsed.plan_id ?? r.parsed.price_id)),
      ...byEntity("addons", ["new"]).map((r) => String(r.parsed.addon_id ?? r.parsed.price_id)),
    ];
    await adopt(tx, run, "product", "products", planIds);
  });

  const priceKinds: StagedInput["priceKinds"] = {};
  for (const r of [
    ...byEntity("plans", ["new", "existing"]),
    ...byEntity("addons", ["new", "existing"]),
  ])
    priceKinds[String(r.parsed.price_id)] =
      entityOf.get(r.id) === "plans" ? "plan" : r.parsed.interval != null ? "addon" : "charge";
  const subCurrency = (rows: StagedRow[]) => {
    const v = rows[0]!.values;
    if (v.currency) return String(v.currency);
    const pid = String(v.price_id);
    const file = [
      ...byEntity("plans", ["new", "existing"]),
      ...byEntity("addons", ["new", "existing"]),
    ].find((r) => r.parsed.price_id === pid);
    return String(file?.parsed.currency ?? "USD");
  };
  const input: StagedInput = {
    plans: staged("plans"),
    addons: staged("addons"),
    coupons: staged("coupons"),
    customers: staged("customers"),
    subscriptions: [...subGroups].map(([sourceId, rows]) => ({
      sourceId,
      rows,
      currency: subCurrency(rows),
    })),
    invoices: [...invGroups].map(([sourceId, rows]) => ({ sourceId, rows })),
    creditNotes: staged("credit_notes"),
    payments: staged("payments"),
    usage: staged("usage"),
    collectOpenInvoices: !!(run.options as RunOptions).collect_open_invoices,
    invoiceCustomers,
    refs: {
      prices: [...refPrices],
      customers: [...refCustomers],
      coupons: [...refCoupons],
      subscriptions: [...refSubs],
      invoices: [...refInvoices],
    },
    priceKinds,
  };
  // Existing prices the subscriptions use: their currency comes from the business.
  if (refPrices.size) {
    const rows = await withTenant(org, (tx) =>
      tx
        .select({ id: prices.publicId, currency: prices.currency, kind: products.kind })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(
          and(eq(prices.businessId, run.businessId), inArray(prices.publicId, [...refPrices])),
        ),
    );
    const cur = new Map(rows.map((r) => [r.id, r.currency]));
    for (const r of rows)
      input.priceKinds[r.id] ??= (r.kind as "plan" | "addon" | "charge") ?? "plan";
    for (const s of input.subscriptions)
      if (!s.rows[0]!.values.currency)
        s.currency = cur.get(String(s.rows[0]!.values.price_id)) ?? s.currency;
  }

  const outcomes = new Map<string, ImportRecordOutcome>();
  // Progress: the new records the rows stand for, and how many of them the engine has done.
  const expected = new Set(
    IMPORT_ENTITIES.flatMap((e) =>
      byEntity(e, ["new"]).map((r) => `${ENTITY_TYPE[e]}:${r.sourceId}`),
    ),
  );
  let done = 0;
  let lastBeat = Date.now();
  const beat = async () => {
    if (Date.now() - lastBeat < PROGRESS_MS) return;
    lastBeat = Date.now();
    await withTenant(org, (tx) =>
      tx
        .update(importRuns)
        .set({ heartbeatAt: new Date(), result: { progress: { done, total: expected.size } } })
        .where(and(eq(importRuns.id, run.id), eq(importRuns.leaseToken, token))),
    );
  };
  const result = await importFromSource({
    organizationId: org,
    businessId: run.businessId,
    source: new StagedSource(run.sourceName, input),
    options: {
      // Settled history is read only when the files carry it.
      includeHistory: HISTORY_ENTITIES.some((e) =>
        (run.files as RunFile[]).some((f) => f.entity === e),
      ),
      includeEvents: false,
      skipGatewayAccounts: true,
      suppressEmittedEvents: true,
      runId: run.id,
      onRecord: async (rec) => {
        const key = `${rec.sourceType}:${rec.sourceId}`;
        if (expected.has(key) && !outcomes.has(key)) done++;
        outcomes.set(key, rec);
        await beat();
      },
      onProgress: beat,
    },
  });

  // Row results from the engine's per-record outcomes.
  const updates: Array<{
    id: string;
    outcome: string;
    message: string | null;
    target: string | null;
  }> = [];
  const perEntity: Record<
    string,
    { created: number; unchanged: number; failed: number; excluded: number }
  > = {};
  for (const r of checked.rows) {
    const e = entityOf.get(r.id)!;
    const c = (perEntity[e] ??= { created: 0, unchanged: 0, failed: 0, excluded: 0 });
    let outcome: "created" | "unchanged" | "failed" | "excluded";
    let message: string | null = null;
    let target: string | null = null;
    if (r.state === "invalid" || r.state === "excluded") {
      outcome = "excluded";
      message = r.errors[0]?.message ?? r.warnings[0]?.message ?? null;
    } else if (r.state === "existing") outcome = "unchanged";
    else {
      const o = outcomes.get(`${ENTITY_TYPE[e]}:${r.sourceId}`);
      if (!o) {
        outcome = "failed";
        message = "The import did not reach this row.";
      } else if (o.outcome === "failed") {
        outcome = "failed";
        message = o.error ?? null;
      } else {
        outcome = o.outcome === "created" ? "created" : "unchanged";
        target = o.targetId ?? null;
      }
    }
    c[outcome]++;
    updates.push({ id: r.id, outcome, message, target });
  }
  await withTenant(org, async (tx) => {
    for (let i = 0; i < updates.length; i += ROW_UPDATE_CHUNK)
      await tx.execute(sql`
        update import_rows r set outcome = x.outcome, outcome_message = x.message, target_id = x.target
          from jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + ROW_UPDATE_CHUNK))}::jsonb)
               as x(id uuid, outcome text, message text, target uuid)
         where r.id = x.id and r.run_id = ${run.id}::uuid`);
  });
  const failed = Object.values(perEntity).reduce((n, c) => n + c.failed, 0);
  const created = Object.values(perEntity).reduce((n, c) => n + c.created, 0);
  const status = failed ? (created ? "partially_failed" : "failed") : "succeeded";
  await finish(org, run, token, status, {
    entities: perEntity,
    engine_counts: result.counts,
    warnings: result.warnings.slice(0, 100),
    charges: result.charges,
  });
  return status;
}

async function finish(
  org: string,
  run: RunRow,
  token: string,
  status: string,
  result: Record<string, unknown> | null,
  error: string | null = null,
) {
  const done = await withTenant(org, async (tx) => {
    const [row] = await tx
      .update(importRuns)
      .set({
        status,
        result: result ?? {},
        error,
        finishedAt: new Date(),
        leaseToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(importRuns.id, run.id), eq(importRuns.leaseToken, token)))
      .returning();
    if (row)
      await writeAuditLog(
        {
          organizationId: org,
          businessId: run.businessId,
          action: "import.run",
          resourceType: "import",
          resourceId: run.id,
          after: {
            status,
            entities: (result as { entities?: unknown } | null)?.entities ?? null,
            error,
          },
          actor: run.startedBy,
        },
        tx,
      );
    return row ?? null;
  });
  if (done)
    await notify(org, done).catch((e) =>
      log.error(e, { event: "import_notify_failed", run: run.id }),
    );
}

const STATUS_TEXT: Record<string, string> = {
  succeeded: "is complete",
  partially_failed: "is complete, with failed rows",
  failed: "failed",
};

/** The import page with this run open. */
function importPageUrl(bizPublicId: string, runId: string): string {
  const base = (config.DASHBOARD_BASE_URL ?? "").replace(/\/$/, "");
  return `${base}/businesses/${bizPublicId}/imports?run=${runId}`;
}

/** Email the member who started the run, once. */
async function notify(org: string, run: RunRow) {
  if (!run.startedByUserId) return;
  const claimed = await withTenant(org, (tx) =>
    tx
      .update(importRuns)
      .set({ notifiedAt: new Date() })
      .where(and(eq(importRuns.id, run.id), isNull(importRuns.notifiedAt)))
      .returning({ id: importRuns.id }),
  );
  if (!claimed.length) return;
  const [u] = await systemDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, run.startedByUserId));
  const [biz] = await systemDb.select().from(businesses).where(eq(businesses.id, run.businessId));
  if (!u?.email || !biz) return;
  const entities =
    ((run.result ?? {}) as { entities?: Record<string, { created: number; failed: number }> })
      .entities ?? {};
  const created = Object.values(entities).reduce((n, c) => n + c.created, 0);
  const failed = Object.values(entities).reduce((n, c) => n + c.failed, 0);
  const { resolveMailer } = await import("@/modules/emails/mailer-resolver");
  const { escapeHtml } = await import("@/modules/emails/sanitize");
  const url = importPageUrl(biz.publicId, run.id);
  const what = STATUS_TEXT[run.status] ?? run.status;
  const lines = [
    `The import into ${biz.name} ${what}.`,
    `Added: ${created}. Failed: ${failed}.`,
    `To see each row, open: ${url}`,
  ];
  await resolveMailer(null).send({
    to: u.email,
    cc: null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject: `The import into ${biz.name} ${what}`,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    idempotencyKey: `import_done:${run.id}`,
  });
}

export async function runUndoJob(runId: string): Promise<string> {
  const run = await loadRun(runId);
  if (!run || run.status !== "undoing") return "not_undoing";
  const before = (run.result ?? {}) as object;
  try {
    const deleted = await performUndo(run.organizationId, run);
    await withTenant(run.organizationId, async (tx) => {
      await tx
        .update(importRuns)
        .set({
          status: "undone",
          undoneAt: new Date(),
          result: { ...before, undo: deleted },
          updatedAt: new Date(),
        })
        .where(eq(importRuns.id, run.id));
      await tx.update(importRows).set({ targetId: null }).where(eq(importRows.runId, run.id));
      await writeAuditLog(
        {
          organizationId: run.organizationId,
          businessId: run.businessId,
          action: "import.undo",
          resourceType: "import",
          resourceId: run.id,
          after: { deleted },
          actor: run.undoneBy,
        },
        tx,
      );
    });
    await notifyUndo(run, "undone", null).catch((e) =>
      log.error(e, { event: "import_undo_notify_failed", run: run.id }),
    );
    return "undone";
  } catch (e) {
    const message =
      e instanceof UndoRefusedError
        ? e.message
        : "We could not undo the import. Nothing was deleted.";
    if (!(e instanceof UndoRefusedError))
      log.error(e, { event: "import_undo_failed", run: run.id });
    // Back to its finished state, with the reason.
    await withTenant(run.organizationId, (tx) =>
      tx
        .update(importRuns)
        .set({ status: finishedStatus(run), error: message, updatedAt: new Date() })
        .where(eq(importRuns.id, run.id)),
    );
    await notifyUndo(run, "refused", message).catch((err) =>
      log.error(err, { event: "import_undo_notify_failed", run: run.id }),
    );
    return "refused";
  }
}

/** Email the member who asked for the undo (or, failing that, who started the import), once. */
async function notifyUndo(run: RunRow, outcome: "undone" | "refused", reason: string | null) {
  const to = run.undoneByUserId ?? run.startedByUserId;
  if (!to) return;
  const claimed = await withTenant(run.organizationId, (tx) =>
    tx
      .update(importRuns)
      .set({ undoNotifiedAt: new Date() })
      .where(and(eq(importRuns.id, run.id), isNull(importRuns.undoNotifiedAt)))
      .returning({ id: importRuns.id }),
  );
  if (!claimed.length) return;
  const [u] = await systemDb.select({ email: users.email }).from(users).where(eq(users.id, to));
  const [biz] = await systemDb.select().from(businesses).where(eq(businesses.id, run.businessId));
  if (!u?.email || !biz) return;
  const { resolveMailer } = await import("@/modules/emails/mailer-resolver");
  const { escapeHtml } = await import("@/modules/emails/sanitize");
  const url = importPageUrl(biz.publicId, run.id);
  const subject =
    outcome === "undone"
      ? `The import into ${biz.name} is undone`
      : `We could not undo the import into ${biz.name}`;
  const lines =
    outcome === "undone"
      ? [
          `The import into ${biz.name} is undone. We deleted the records it added.`,
          `To see the import, open: ${url}`,
        ]
      : [
          `We could not undo the import into ${biz.name}. ${reason ?? ""}`.trim(),
          `To see the import, open: ${url}`,
        ];
  await resolveMailer(null).send({
    to: u.email,
    cc: null,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    idempotencyKey: `import_undo:${run.id}:${run.updatedAt.getTime()}`,
  });
}

/** The status a run had before an undo was asked for, from its stored result. */
function finishedStatus(run: RunRow): string {
  const ent =
    ((run.result ?? {}) as { entities?: Record<string, { created: number; failed: number }> })
      .entities ?? {};
  const failed = Object.values(ent).reduce((n, c) => n + c.failed, 0);
  const created = Object.values(ent).reduce((n, c) => n + c.created, 0);
  return failed ? (created ? "partially_failed" : "failed") : "succeeded";
}

/** Clock pass: a run whose runner stopped sending heartbeats is queued again. */
export async function requeueStalledImports(now: Date): Promise<number> {
  const stale = new Date(now.getTime() - LEASE_STALE_MS);
  const rows = await systemDb
    .select({ id: importRuns.id, status: importRuns.status })
    .from(importRuns)
    .where(
      and(
        inArray(importRuns.status, ["queued", "running", "checking", "undoing"]),
        // An ISO string, not a Date: a Date inside raw sql breaks the driver.
        sql`coalesce(${importRuns.heartbeatAt}, ${importRuns.queuedAt}, ${importRuns.updatedAt}) < ${stale.toISOString()}::timestamptz`,
      ),
    );
  for (const r of rows) {
    const task =
      r.status === "checking"
        ? "import_check"
        : r.status === "undoing"
          ? "import_undo"
          : "import_run";
    await systemDb.execute(
      sql`select graphile_worker.add_job(${task}, json_build_object('run', ${r.id}::text), max_attempts => 5, job_key => ${`${task}:${r.id}`})`,
    );
  }
  return rows.length;
}
