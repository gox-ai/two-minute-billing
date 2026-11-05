/**
 * The live generator: drives the real engine through Time Travel, one billing tick per
 * simulated day, while scripted signups, plan changes, cancels, pauses, card failures and
 * offline payments happen in between. Correct but slow (minutes) — `pnpm seed` loads a
 * snapshot of its output instead; this runs under `pnpm seed --live` and `pnpm seed:capture`.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { businesses } from "@db/schema";
import { createBusiness } from "@/modules/tenancy/service";
import { listGatewayAccounts, updateGatewayAccount } from "@/modules/gateway/service";
import { scanMetricDrift } from "@/modules/metrics/daily/maintenance";
import { startTimeTravel, stopTimeTravel } from "@/modules/time-travel/service";
import { Sim, DAY } from "./api";
import { createCatalog, createTax, type TaxSetup } from "./catalog";
import { Lifecycle, type BizSpec } from "./lifecycle";
import { rng } from "./people";
import {
  acmeDunningSetup,
  acmeDunningBreak,
  acmeToday,
  nimbusToday,
  type Showcase,
} from "./fixtures";
import {
  rebuildReporting,
  refreshMovements,
  skipHistoricalMail,
  summarise,
  type BizSummary,
} from "./reporting";

const specsFor = (small: boolean): Array<BizSpec & { tax: TaxSetup }> => [
  {
    key: "acme",
    name: "Acme Analytics",
    currency: "USD",
    region: "US",
    timezone: "America/New_York",
    tax: "us",
    months: small ? 4 : 14,
    signups: small ? [4, 8] : [7, 28],
    book: {
      plans: {
        starter: { month: 2900, year: 29000 },
        growth: { month: 7900, year: 79000 },
        pro: { month: 19900, year: 199000 },
        enterprise: { month: 99900, year: 999000 },
      },
      seat: { month: 1200, year: 12000 },
      usageUnit: 50,
      setup: 49900,
      team: [29900, 89900, 199900],
      loyalOff: 500,
    },
  },
  {
    key: "nimbus",
    name: "Nimbus Cloud",
    currency: "INR",
    region: "IN",
    timezone: "Asia/Kolkata",
    tax: "in",
    months: small ? 3 : 12,
    signups: small ? [2, 4] : [3, 8],
    book: {
      plans: {
        starter: { month: 99900, year: 999000 },
        growth: { month: 299900, year: 2999000 },
        pro: { month: 799900, year: 7999000 },
        enterprise: { month: 3999900, year: 39999000 },
      },
      seat: { month: 39900, year: 399000 },
      usageUnit: 2000,
      setup: 2500000,
      team: [999900, 2999900, 6999900],
      loyalOff: 50000,
    },
  },
  {
    key: "fjord",
    name: "Fjord Tools",
    currency: "EUR",
    region: "EU",
    timezone: "Europe/Amsterdam",
    tax: "eu",
    months: small ? 3 : 10,
    signups: small ? [2, 3] : [2, 6],
    book: {
      plans: {
        starter: { month: 2500, year: 25000 },
        growth: { month: 6900, year: 69000 },
        pro: { month: 17900, year: 179000 },
        enterprise: { month: 89900, year: 899000 },
      },
      seat: { month: 1000, year: 10000 },
      usageUnit: 40,
      setup: 39900,
      team: [24900, 79900, 179900],
      loyalOff: 400,
    },
  },
];

interface LiveCtx {
  app: FastifyInstance;
  secret: string;
  orgId: string;
  small: boolean;
}

export interface SeededBusiness {
  name: string;
  publicId: string;
  summary: BizSummary;
  showcase: string[];
}

interface Seeded {
  spec: BizSpec;
  publicId: string;
  summary: BizSummary;
  showcase: string[];
  lc: Lifecycle;
}

async function seedBusiness(ctx: LiveCtx, spec: BizSpec & { tax: TaxSetup }): Promise<Seeded> {
  const { app, secret, orgId, small } = ctx;
  const t0 = Date.now();
  const r = rng(`${spec.key}:${small ? "small" : "full"}`);
  // Every simulated day is a full 24h ending at the same time of day as `final`, so the
  // last tick lands just before real now and the business rejoins the real clock cleanly.
  const final = new Date(Date.now() - 3 * 60_000);
  const firstOfMonth = Date.UTC(final.getUTCFullYear(), final.getUTCMonth() - spec.months, 1);
  const days = Math.ceil((final.getTime() - firstOfMonth) / DAY);
  const genesis = new Date(final.getTime() - days * DAY);

  // Test mode: it provisions a TM Test Gateway and is the only mode Time Travel runs on.
  const biz = await createBusiness({
    organizationId: orgId,
    name: spec.name,
    defaultCurrency: spec.currency,
    livemode: "test",
    ...(spec.timezone ? { timezone: spec.timezone } : {}),
  });
  await systemDb.update(businesses).set({ createdAt: genesis }).where(eq(businesses.id, biz.id));
  // The test gateway's magic amounts key outcomes off the charge amount (…13 minor → gateway
  // 500 → a pending payment only a human resolves). Generated totals hit them by accident.
  for (const gwa of await listGatewayAccounts(orgId, biz.id))
    if (gwa.gatewayKey === "tmtest")
      await updateGatewayAccount({
        organizationId: orgId,
        businessId: biz.id,
        gwaPublicId: gwa.publicId,
        credentials: { magic_amounts: false },
      });
  const sim = new Sim(app, secret, orgId, biz.id, biz.publicId, genesis);
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: genesis });
  const cat = await sim.at(genesis, async () => {
    const c = await createCatalog(sim.ctx, spec.currency, spec.book);
    await createTax(sim.ctx, spec.tax);
    return c;
  });
  const lc = new Lifecycle(sim, spec, cat, r);

  // Signups per calendar month grow linearly; each lands on a random day of its month.
  const monthOf = (d: number) => {
    const end = new Date(genesis.getTime() + d * DAY);
    return (
      (end.getUTCFullYear() - new Date(firstOfMonth).getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      new Date(firstOfMonth).getUTCMonth()
    );
  };
  const signupsOn = new Map<number, number>();
  const monthDays = new Map<number, number[]>();
  for (let d = 1; d <= days; d++)
    monthDays.set(monthOf(d), [...(monthDays.get(monthOf(d)) ?? []), d]);
  const monthCount = monthDays.size;
  for (const [m, ds] of monthDays) {
    const target = Math.round(
      spec.signups[0] + ((spec.signups[1] - spec.signups[0]) * m) / Math.max(1, monthCount - 1),
    );
    const count = Math.max(1, Math.round((target * ds.length) / 30));
    for (let i = 0; i < count; i++) {
      const d = ds[r.int(0, ds.length - 1)]!;
      signupsOn.set(d, (signupsOn.get(d) ?? 0) + 1);
    }
  }

  const showcase: Showcase = {};
  let showcaseLines: string[] = [];
  // The businesses run concurrently, so every line names its business.
  const say = (line: string) => console.log(`${spec.name.split(" ")[0]!.padEnd(6)} ${line}`);
  say(`▶ ${spec.currency} — ${days} simulated days from ${genesis.toISOString().slice(0, 10)}`);
  for (let d = 1; d <= days; d++) {
    const dayStart = new Date(genesis.getTime() + (d - 1) * DAY);
    const dayEnd = new Date(genesis.getTime() + d * DAY);
    const beforeTick = new Date(dayEnd.getTime() - 30 * 60_000);
    const month = monthOf(d);
    await lc.runDay(dayStart, dayEnd, month, signupsOn.get(d) ?? 0);
    if (spec.key === "acme" && d === days - 33) await acmeDunningSetup(lc, beforeTick, showcase);
    if (spec.key === "acme" && d === days - 31) await acmeDunningBreak(lc, beforeTick, showcase);
    if (d === Math.floor(days * 0.66)) await lc.historicalInvoiceStates(beforeTick);
    if (dayEnd.getUTCDate() === 20 || d === days)
      await lc.ensureMonthMovements(new Date(beforeTick.getTime() - 60 * 60_000));
    if (d === days) {
      await lc.scheduleFuture(new Date(beforeTick.getTime() - 50 * 60_000));
      if (spec.key === "acme") showcaseLines = await acmeToday(lc, beforeTick);
      if (spec.key === "nimbus") showcaseLines = await nimbusToday(lc, beforeTick);
    }
    await sim.travelTo(dayEnd);
    if (d === days || monthOf(d + 1) !== month) {
      say(await lc.monthLine(dayEnd.toISOString().slice(0, 7)));
    }
  }
  await sim.travelTo(new Date());
  const skipped = await skipHistoricalMail(biz.id);
  await stopTimeTravel({ orgId, bizId: biz.id, wipe: false });
  const tr = Date.now();
  const rep = await rebuildReporting({
    organizationId: orgId,
    businessId: biz.id,
    timezone: spec.timezone ?? null,
    genesis,
  });
  if (showcase.dunning)
    showcaseLines.push(
      `Jonas Lindqvist (${showcase.dunning.id}) — renewal declined, dunning in progress`,
    );
  const summary = await summarise(biz.id);
  const refused = Object.entries(lc.stats.refused)
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
  say(
    `reporting: ${rep.days} days · ${rep.metricRows} metric rows` +
      ` (${((Date.now() - tr) / 1000).toFixed(0)}s) · ${skipped} historical emails skipped` +
      ` · ${((Date.now() - t0) / 1000).toFixed(0)}s total` +
      (refused ? ` · refused by the engine (business rules, expected): ${refused}` : ""),
  );
  return { spec, publicId: biz.publicId, summary, showcase: showcaseLines, lc };
}

/** Generate every business under an org that already exists (signup done by the caller). */
export async function runLive(ctx: LiveCtx): Promise<SeededBusiness[]> {
  // Independent businesses (own clock, own tick scope), so they run side by side.
  const seeded = await Promise.all(specsFor(ctx.small).map((spec) => seedBusiness(ctx, spec)));
  await refreshMovements();
  // The drift invariant reads the nightly scan's last result; a book no worker has scanned
  // yet reports "never run", so record one estate-wide scan over the freshly built history.
  await scanMetricDrift();
  return seeded.map((s) => ({
    name: s.spec.name,
    publicId: s.publicId,
    summary: s.summary,
    showcase: s.showcase,
  }));
}
