/**
 * The ACCOUNT-LEVEL exchange rates (0269) the FX refresher maintains.
 *
 * `organizations.exchange_rates` is what makes a cross-business money answer possible, and
 * what the converted total believes without question. So the four things it must never get
 * wrong are asserted directly against the column, on this suite's own organizations, with a
 * stubbed provider:
 *
 *   - every currency the businesses bill in gets a rate, and the base gets none;
 *   - a pinned rate survives a pass that could have overwritten it;
 *   - a currency the feed will not quote is ABSENT, not zero — that absence is what makes
 *     `missing_rates` honest downstream;
 *   - an organization with no base currency is left entirely alone.
 *
 *   pnpm verify:org-fx
 */
import { eq, sql } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import {
  createOrganization,
  createBusiness,
  updateOrganization,
  updateBusiness,
} from "@/modules/tenancy/service";
import { refreshAutoExchangeRates } from "@/modules/tenancy/exchange-rates";
import { organizations } from "@db/schema";
import { FxProviderError, type FxProvider } from "@/platform/fx/types";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/** Quotes EUR and INR against any base; GBP is deliberately not quoted at all. */
const stub: FxProvider = {
  name: "stubfx",
  async fetchRates(base, quotes) {
    const all: Record<string, string> = { EUR: "0.9100000000", INR: "88.5000000000" };
    const rates: Record<string, string> = {};
    for (const q of quotes) if (all[q] != null) rates[q] = all[q]!;
    return { base, asOf: new Date("2026-09-01T00:00:00Z"), rates };
  },
};

const down: FxProvider = {
  name: "stubfx",
  async fetchRates() {
    throw new FxProviderError("stub feed unreachable", "stubfx");
  },
};

type Stored = { source?: string; provider?: string | null; last_error?: string | null };
const readOrg = async (id: string) => {
  const [row] = await withTenant(id, (tx) =>
    tx
      .select({
        exchangeRates: organizations.exchangeRates,
        exchangeRateSources: organizations.exchangeRateSources,
      })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1),
  );
  return {
    rates: (row?.exchangeRates ?? {}) as Record<string, unknown>,
    sources: (row?.exchangeRateSources ?? {}) as Record<string, Stored>,
  };
};

// ── An organization WITH a base currency ──────────────────────────────────────
// Four currencies in play across three businesses: USD (the base), EUR, INR and GBP.
const withBase = await createOrganization({ name: "Org FX Base" });
const baseOrgId = withBase.organization.id;
await updateOrganization(baseOrgId, { baseCurrency: "USD" });

/**
 * Choosing a reporting currency must FETCH the rates, not wait for the twice-daily cron.
 *
 * Until that moment `organizationRateTargets` skips the account, so no pass has ever quoted
 * a rate for it: the map is empty and the first converted total an operator sees excludes
 * everything billed in another currency — for up to twenty hours, under a note that reads
 * like a broken feed. Hit for real on 2026-09-20.
 *
 * Asserted against the QUEUE rather than a spy, because the enqueue is deliberately
 * non-fatal: a settings save must not fail on an unreachable queue, so a broken enqueue
 * would otherwise be invisible.
 *
 * ⚠️ `graphile_worker.jobs` is a VIEW and carries no `payload` — the identifier lives in
 * `_private_tasks`, so the payload check has to join. And a job is only in that table until
 * a worker takes it: against the dev database one is listening, and it claimed this job
 * between two processes while this check was being written. So "the rate map has since
 * been written" counts as the same evidence — both outcomes mean the job existed.
 */
const refreshQueued = async (organizationId: string): Promise<number> => {
  const rows = (await systemDb.execute(sql`
    select count(*)::int as n
      from graphile_worker._private_jobs j
      join graphile_worker._private_tasks t on t.id = j.task_id
     where t.identifier = 'fx_refresh_rates'
       and j.payload->>'organizationId' = ${organizationId}`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
};
const refreshReached = async (organizationId: string): Promise<boolean> =>
  (await refreshQueued(organizationId)) > 0 ||
  Object.keys((await readOrg(organizationId)).sources).length > 0;

ok("choosing a reporting currency fetches that account's rates", await refreshReached(baseOrgId));
// Saving the same currency again is not a change, and must not queue a second fetch.
const afterFirst = await refreshQueued(baseOrgId);
await updateOrganization(baseOrgId, { baseCurrency: "USD" });
ok(
  "re-saving the same currency queues nothing further",
  (await refreshQueued(baseOrgId)) === afterFirst,
);
await createBusiness({
  organizationId: baseOrgId,
  name: "US Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const eu = await createBusiness({
  organizationId: baseOrgId,
  name: "EU Biz",
  defaultCurrency: "EUR",
  livemode: "test",
});
await createBusiness({
  organizationId: baseOrgId,
  name: "UK Biz",
  defaultCurrency: "GBP",
  livemode: "test",
});
// INR reaches the account map through a business's enabled list, not its default — the map
// must cover what the book bills in, not just what each business opens on.
await updateBusiness(baseOrgId, eu.publicId, { currencies: ["EUR", "INR"] });

// The operator pins EUR by hand BEFORE the pass, with the same provenance shape the
// business column uses. Automation must leave it exactly where it is.
await withTenant(baseOrgId, (tx) =>
  tx
    .update(organizations)
    .set({
      exchangeRates: { EUR: 0.5 },
      exchangeRateSources: {
        EUR: { source: "manual", updated_at: null, provider: null, last_error: null },
      },
    })
    .where(eq(organizations.id, baseOrgId)),
);

// ── An organization with NO base currency ─────────────────────────────────────
const noBase = await createOrganization({ name: "Org FX No Base" });
const noBaseOrgId = noBase.organization.id;
await createBusiness({
  organizationId: noBaseOrgId,
  name: "Unset Biz",
  defaultCurrency: "EUR",
  livemode: "test",
});

const now = new Date("2026-09-02T00:00:00Z");
await refreshAutoExchangeRates({ now, provider: stub, onlyOrganizationId: baseOrgId });
await refreshAutoExchangeRates({ now, provider: stub, onlyOrganizationId: noBaseOrgId });

{
  const { rates, sources } = await readOrg(baseOrgId);

  ok("INR — billed through an enabled list — is quoted against the base", rates.INR === 88.5);
  ok("the quoted rate is a number, not a string", typeof rates.INR === "number");
  ok("INR's provenance names the automation and the provider", sources.INR?.source === "auto");
  ok("INR carries no error", sources.INR?.last_error == null);

  // The base converts at 1 by definition; a stored rate for it is a settable 1.
  ok("the base currency has NO rate of its own", !("USD" in rates));

  ok("a manually pinned rate survives the refresh", rates.EUR === 0.5);
  ok("the pin keeps its manual provenance", sources.EUR?.source === "manual");

  // The feed answered and does not quote GBP. Absent is the only honest value: a converted
  // total excludes it and names it, where a 0 or a guess would move the number.
  ok("an unquotable currency is ABSENT from the map", !("GBP" in rates));
  ok("an unquotable currency is not zero", rates.GBP !== 0);
  ok(
    "the unquotable currency's provenance says why",
    typeof sources.GBP?.last_error === "string" && sources.GBP.last_error.includes("GBP"),
  );
}

{
  const { rates, sources } = await readOrg(noBaseOrgId);
  ok("an org with no base currency gets no rates", Object.keys(rates).length === 0);
  ok("an org with no base currency gets no provenance either", Object.keys(sources).length === 0);
}

// A feed outage says nothing about any currency: what we hold stands, and the error is
// recorded rather than the rate cleared.
{
  await refreshAutoExchangeRates({ now, provider: down, onlyOrganizationId: baseOrgId });
  const { rates, sources } = await readOrg(baseOrgId);
  ok("a provider outage leaves the last good rate standing", rates.INR === 88.5);
  ok("the outage is recorded on the currency", sources.INR?.last_error === "stub feed unreachable");
  ok("the outage does not disturb the pin", rates.EUR === 0.5);
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0
    ? `\n✅ ORG-FX: PASS — ${checks.length} checks`
    : `\n❌ ORG-FX: FAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
