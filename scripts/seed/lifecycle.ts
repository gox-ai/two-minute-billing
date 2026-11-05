/**
 * Day-by-day history for one business: signups, plan changes, cancels, pauses, card
 * failures, usage and offline payments, with a real billing tick closing every day.
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createCustomer, getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  recordOfflinePayment,
  writeOffInvoice,
  createManualInvoice,
  voidInvoice,
} from "@/modules/invoicing/ops";
import { issueCreditNote } from "@/modules/credit-notes/service";
import { topUpWallet } from "@/modules/wallet/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import { DEFAULT_CANCELLATION_REASONS } from "@/modules/reason-codes/service";
import { ApiError, DAY, type Json, type Sim } from "./api";
import { PLAN_LADDER, type Catalog, type PlanKey, type PriceBook } from "./catalog";
import { makePerson, gstin, type Person, type Region, type Rng } from "./people";

export interface BizSpec {
  key: string;
  name: string;
  currency: string;
  region: Region;
  timezone?: string;
  months: number;
  /** Signups in the first and the last month (linear in between). */
  signups: [number, number];
  book: PriceBook;
}

export interface SubRec {
  id: string;
  cus: string;
  customerId: string;
  email: string;
  plan: PlanKey;
  interval: "month" | "year";
  metered: boolean;
  team: boolean;
  offline: boolean;
  /** A named showcase record: random lifecycle events leave it alone. */
  pinned?: boolean;
  resumeAt?: number;
  fixCardAt?: number;
  reactivateAt?: number;
}

export interface Stats {
  signups: number;
  ops: Record<string, number>;
  refused: Record<string, number>;
}

const REASONS = DEFAULT_CANCELLATION_REASONS.map((r) => r.code).filter(
  (c) => c !== "pausing_will_return",
);
const GOOD = "tok_4242";
const INSUFFICIENT = "4000000000009995";
const HARD = "4000000000000002";
const RETRY = "4000000000002008";
const GST_STATE: Record<string, string> = { TN: "33", KA: "29", MH: "27", TG: "36" };

/** Monthly rates per live subscription. */
const RATE = {
  upgrade: 0.03,
  downgrade: 0.015,
  seats: 0.05,
  toYearly: 0.01,
  cancelMonthly: 0.022,
  cancelYearly: 0.008,
  pause: 0.005,
  coupon: 0.008,
  breakInsufficient: 0.006,
  breakHard: 0.003,
};

const money = (minor: number, currency: string) =>
  `${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export class Lifecycle {
  readonly subs: SubRec[] = [];
  readonly stats: Stats = { signups: 0, ops: {}, refused: {} };
  private n = 0;
  private partnerUsed = 0;
  private offlinePlan = new Map<
    string,
    Array<{ at: number; amount: number | undefined; method: string }>
  >();
  private wroteOff = false;
  private voided = false;
  private monthSignups = 0;

  constructor(
    readonly sim: Sim,
    readonly spec: BizSpec,
    readonly cat: Catalog,
    readonly r: Rng,
  ) {}

  private bump(k: string) {
    this.stats.ops[k] = (this.stats.ops[k] ?? 0) + 1;
  }

  /** Run an API op; a business-rule refusal (4xx) is counted, not fatal. */
  private async attempt<T>(op: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const out = await fn();
      this.bump(op);
      return out;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        this.stats.refused[op] = (this.stats.refused[op] ?? 0) + 1;
        if (process.env.SEED_DEBUG) console.log(`   refused ${op}: ${e.message}`);
        return null;
      }
      throw e;
    }
  }

  // ── signups ────────────────────────────────────────────────────────────────

  async signup(
    t: Date,
    opts: Partial<{
      plan: PlanKey;
      interval: "month" | "year";
      trial: "convert" | "no_card" | "hard" | "retry" | null;
      offline: boolean;
      coupon: string | null;
      company: boolean;
      person: Person;
      seats: number;
      metered: boolean;
      overridePct: number;
    }> = {},
  ): Promise<SubRec | null> {
    const { r, spec, cat, sim } = this;
    const plan =
      opts.plan ?? r.weighted<PlanKey>({ starter: 40, growth: 33, pro: 20, enterprise: 7 });
    const company = opts.company ?? (plan === "enterprise" || r.chance(0.6));
    const offline = opts.offline ?? (plan === "enterprise" && r.chance(0.6));
    const interval =
      opts.interval ?? (r.chance(plan === "enterprise" ? 0.35 : 0.18) ? "year" : "month");
    const trial =
      opts.trial !== undefined
        ? opts.trial
        : plan !== "enterprise" && interval === "month" && r.chance(0.3)
          ? r.weighted({ convert: 65, no_card: 18, hard: 7, retry: 10 })
          : null;
    const team = plan === "pro" && interval === "month" && !trial && r.chance(0.08);
    const metered =
      opts.metered ??
      (interval === "month" && (plan === "pro" || plan === "enterprise") && r.chance(0.4));
    const seats =
      opts.seats ??
      (plan !== "starter" && !team && r.chance(0.65)
        ? r.int(1, plan === "enterprise" ? 25 : 8)
        : 0);
    const setup = plan === "enterprise" || (plan === "pro" && r.chance(0.15));
    let coupon =
      opts.coupon !== undefined
        ? opts.coupon
        : r.chance(0.15)
          ? r.weighted({ welcome: 5, three: 3, partner: 2 })
          : null;
    if (coupon === "partner" && this.partnerUsed >= cat.partnerCap) coupon = "welcome";
    const code =
      coupon === "welcome"
        ? cat.coupons.welcome
        : coupon === "three"
          ? cat.coupons.threeMonths
          : coupon === "partner"
            ? cat.coupons.partner
            : coupon;
    const person = opts.person ?? makePerson(r, spec.region, ++this.n, company);
    const card =
      trial === "no_card" || offline
        ? null
        : trial === "hard"
          ? HARD
          : trial === "retry"
            ? RETRY
            : GOOD;
    const pendingInvoices = metered && r.chance(0.3);
    const pct = opts.overridePct ?? (plan === "enterprise" ? 70 + r.int(0, 20) : undefined);
    const override = pct ? Math.round((spec.book.plans[plan][interval] * pct) / 100) : undefined;
    const teamQty = team ? r.pick([6, 14, 22, 38, 55]) : 0;

    return sim.at(t, async () => {
      const taxId =
        spec.region === "IN" &&
        company &&
        r.chance(0.6) &&
        GST_STATE[person.address.stateCode ?? ""]
          ? gstin(
              GST_STATE[person.address.stateCode!]!,
              `AAB${"CFHPT"[r.int(0, 4)]}${String.fromCharCode(65 + r.int(0, 25))}${r.int(1000, 9999)}${String.fromCharCode(65 + r.int(0, 25))}`,
            )
          : undefined;
      const customer = await createCustomer({
        ...sim.ctx,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        ...(person.company ? { company: person.company } : {}),
        address: person.address,
        ...(offline ? { autoCollection: "off" as const, netTermDays: 30 } : {}),
        ...(taxId ? { taxRegistrationNumber: taxId } : {}),
      });
      if (card) await vaultPaymentMethod({ ...sim.ctx, customer, token: card });
      const items: Json[] = [
        team
          ? { price: cat.team, quantity: teamQty }
          : {
              price: cat.plan[plan][interval],
              ...(override ? { unit_price_minor: override } : {}),
            },
      ];
      if (seats) items.push({ price: cat.seat[interval], quantity: seats });
      if (metered) items.push({ price: cat.usage });
      const sub = await this.attempt("signup", () =>
        sim.call("POST", `/customers/${customer.publicId}/subscriptions`, {
          items,
          trial_days: trial ? 14 : 0,
          ...(code ? { coupon_ids: [code] } : {}),
          ...(offline ? { auto_collection: "off", net_term_days: 30 } : {}),
          ...(pendingInvoices ? { create_pending_invoices: true } : {}),
        }),
      );
      if (!sub) return null;
      if (coupon === "partner") this.partnerUsed++;
      this.stats.signups++;
      this.monthSignups++;
      if (setup && !trial) {
        await this.attempt("setup_fee", () =>
          sim.call("POST", `/subscriptions/${sub.id}/charges`, {
            charges: [{ price: cat.setup }],
            invoice_now: true,
          }),
        );
      }
      const rec: SubRec = {
        id: sub.id,
        cus: customer.publicId,
        customerId: customer.id,
        email: person.email,
        plan,
        interval,
        metered,
        team,
        offline,
      };
      this.subs.push(rec);
      return rec;
    });
  }

  // ── lifecycle ops ──────────────────────────────────────────────────────────

  private async items(rec: SubRec): Promise<Json[]> {
    const s = await this.sim.call("GET", `/subscriptions/${rec.id}`);
    return s.items as Json[];
  }

  async upgrade(rec: SubRec): Promise<boolean> {
    if (rec.team || rec.plan === "pro" || rec.plan === "enterprise") return false;
    const next = PLAN_LADDER[PLAN_LADDER.indexOf(rec.plan) + 1]!;
    const items = await this.items(rec);
    const planItem = items.find((i) => i.product_kind === "plan");
    if (!planItem) return false;
    const ok = await this.attempt("upgrade", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/change`, {
        changes: [{ item: planItem.id, price: this.cat.plan[next][rec.interval] }],
      }),
    );
    if (ok) rec.plan = next;
    return !!ok;
  }

  async downgrade(rec: SubRec): Promise<boolean> {
    if (rec.team || rec.plan === "starter" || rec.plan === "enterprise") return false;
    const next = PLAN_LADDER[PLAN_LADDER.indexOf(rec.plan) - 1]!;
    const items = await this.items(rec);
    const planItem = items.find((i) => i.product_kind === "plan");
    if (!planItem) return false;
    const removes =
      next === "starter" ? items.filter((i) => i.product_kind === "addon").map((i) => i.id) : [];
    const ok = await this.attempt("downgrade", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/change`, {
        changes: [{ item: planItem.id, price: this.cat.plan[next][rec.interval] }],
        ...(removes.length ? { removes } : {}),
      }),
    );
    if (ok) {
      rec.plan = next;
      if (removes.length) rec.metered = false;
    }
    return !!ok;
  }

  async seats(rec: SubRec, delta: number): Promise<boolean> {
    const items = await this.items(rec);
    if (rec.team) {
      const planItem = items.find((i) => i.product_kind === "plan");
      if (!planItem) return false;
      const q = Math.max(1, planItem.quantity + delta * 4);
      if (q === planItem.quantity) return false;
      return !!(await this.attempt(delta > 0 ? "seats_up" : "seats_down", () =>
        this.sim.call("POST", `/subscriptions/${rec.id}/change`, {
          changes: [{ item: planItem.id, quantity: q }],
        }),
      ));
    }
    if (rec.plan === "starter") return false;
    const seat = items.find((i) => i.price === this.cat.seat[rec.interval]);
    if (!seat) {
      if (delta < 0) return false;
      return !!(await this.attempt("seats_up", () =>
        this.sim.call("POST", `/subscriptions/${rec.id}/change`, {
          adds: [{ price: this.cat.seat[rec.interval], quantity: delta }],
        }),
      ));
    }
    const q = seat.quantity + delta;
    const body = q <= 0 ? { removes: [seat.id] } : { changes: [{ item: seat.id, quantity: q }] };
    return !!(await this.attempt(delta > 0 ? "seats_up" : "seats_down", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/change`, body),
    ));
  }

  async toYearly(rec: SubRec): Promise<boolean> {
    if (rec.interval === "year" || rec.metered || rec.team) return false;
    const items = await this.items(rec);
    const changes = items
      .filter((i) => i.price_type === "recurring")
      .map((i) =>
        i.product_kind === "plan"
          ? { item: i.id, price: this.cat.plan[rec.plan].year }
          : { item: i.id, price: this.cat.seat.year },
      );
    const ok = await this.attempt("to_yearly", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/change`, { changes }),
    );
    if (ok) rec.interval = "year";
    return !!ok;
  }

  async cancel(rec: SubRec, immediately: boolean, t: Date): Promise<boolean> {
    const ok = await this.attempt(immediately ? "cancel_now" : "cancel_eot", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/cancel`, {
        cancel_option: immediately ? "immediately" : "end_of_term",
        cancel_reason_code: this.r.pick(REASONS),
      }),
    );
    if (ok && this.r.chance(0.12)) rec.reactivateAt = t.getTime() + this.r.int(20, 80) * DAY;
    return !!ok;
  }

  async pause(rec: SubRec, t: Date): Promise<void> {
    const ok = await this.attempt("pause", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/pause`, { pause_option: "immediately" }),
    );
    if (ok) rec.resumeAt = t.getTime() + this.r.int(20, 75) * DAY;
  }

  async resume(rec: SubRec): Promise<void> {
    rec.resumeAt = undefined;
    await this.attempt("resume", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/resume`, {}),
    );
  }

  async reactivate(rec: SubRec): Promise<void> {
    rec.reactivateAt = undefined;
    await this.attempt("reactivate", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/reactivate`, {}),
    );
  }

  async coupon(rec: SubRec): Promise<void> {
    const code = this.r.chance(0.5) ? this.cat.coupons.loyal : this.cat.coupons.threeMonths;
    await this.attempt("coupon_midlife", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/discount`, { code }),
    );
  }

  /** Replace the customer's default card with one that fails from now on. */
  async swapCard(rec: SubRec, token: string, op: string): Promise<void> {
    const customer = await getCustomerByPublicId(this.sim.orgId, this.sim.bizId, rec.cus);
    if (!customer) return;
    const pm = await vaultPaymentMethod({ ...this.sim.ctx, customer, token });
    await this.attempt(op, () =>
      this.sim.call("POST", `/customers/${rec.cus}/payment_methods/${pm.publicId}/default`, {}),
    );
  }

  async breakCard(rec: SubRec, hard: boolean, t: Date): Promise<void> {
    await this.swapCard(
      rec,
      hard ? HARD : INSUFFICIENT,
      hard ? "card_hard_decline" : "card_insufficient",
    );
    if (!hard && this.r.chance(0.5)) {
      const s = await this.sim.call("GET", `/subscriptions/${rec.id}`);
      const end = s.current_period_end ? Date.parse(s.current_period_end) : t.getTime() + 30 * DAY;
      rec.fixCardAt = end + this.r.int(2, 4) * DAY;
    }
  }

  async usage(rec: SubRec, t: Date, month: number): Promise<void> {
    const items = await this.items(rec);
    const meter = items.find((i) => i.price === this.cat.usage);
    if (!meter) return;
    const quantity = Math.round(this.r.int(20, 140) * (1 + month / 10));
    await this.attempt("usage", () =>
      this.sim.call("POST", `/subscriptions/${rec.id}/usage`, {
        item: meter.id,
        quantity,
        timestamp: t.toISOString(),
      }),
    );
  }

  // ── the day loop ─────────────────────────────────────────────────────────

  private async statuses(): Promise<Map<string, string>> {
    const rows = (await systemDb.execute(
      sql`select public_id, status from subscriptions where business_id = ${this.sim.bizId}::uuid`,
    )) as unknown as Array<{ public_id: string; status: string }>;
    return new Map(rows.map((x) => [x.public_id, x.status]));
  }

  /** Scripted events for one simulated day, spread between `start` and `end`. */
  async runDay(dayStart: Date, dayEnd: Date, month: number, signupsToday: number): Promise<void> {
    const { r } = this;
    const span = dayEnd.getTime() - dayStart.getTime();
    const times = Array.from(
      { length: 64 },
      () => dayStart.getTime() + span * (0.05 + 0.85 * r.next()),
    ).sort((a, b) => a - b);
    let ti = 0;
    const next = () => new Date(times[Math.min(ti++, times.length - 1)]!);

    for (let i = 0; i < signupsToday; i++) await this.signup(next());

    const status = await this.statuses();
    const t = next();
    await this.sim.at(t, async () => {
      for (const rec of [...this.subs]) {
        const st = status.get(rec.id);
        if (rec.resumeAt && rec.resumeAt <= t.getTime() && st === "paused") await this.resume(rec);
        if (rec.fixCardAt && rec.fixCardAt <= t.getTime()) {
          rec.fixCardAt = undefined;
          await this.swapCard(rec, GOOD, "card_fixed");
        }
        if (rec.reactivateAt && rec.reactivateAt <= t.getTime()) {
          if (st === "cancelled") await this.reactivate(rec);
          else rec.reactivateAt = undefined;
        }
        if (st !== "active" || rec.offline || rec.pinned) continue;
        const p = (rate: number) => r.chance(rate / 30);
        if (p(rec.interval === "month" ? RATE.cancelMonthly : RATE.cancelYearly)) {
          await this.cancel(rec, r.chance(0.5), t);
          continue;
        }
        if (p(RATE.upgrade)) await this.upgrade(rec);
        else if (p(RATE.downgrade)) await this.downgrade(rec);
        else if (p(RATE.seats)) await this.seats(rec, r.chance(0.7) ? r.int(1, 3) : -r.int(1, 2));
        else if (p(RATE.toYearly)) await this.toYearly(rec);
        else if (p(RATE.pause)) await this.pause(rec, t);
        else if (p(RATE.coupon)) await this.coupon(rec);
        else if (p(RATE.breakInsufficient)) await this.breakCard(rec, false, t);
        else if (p(RATE.breakHard)) await this.breakCard(rec, true, t);
        if (rec.metered && p(4)) await this.usage(rec, t, month);
      }
    });
    await this.offlinePayments(next());
    if (r.chance(1 / 40)) await this.creditOrRefund(next());
    if (r.chance(1 / 45)) await this.walletGrant(next());
  }

  /** Force at least one expansion, contraction and churn into the month if none happened. */
  async ensureMonthMovements(t: Date): Promise<void> {
    const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    const rows = (await systemDb.execute(sql`
      select distinct reason from mrr_movements
      where business_id = ${this.sim.bizId}::uuid and occurred_at >= ${monthStart.toISOString()}::timestamptz
    `)) as unknown as Array<{ reason: string }>;
    const have = new Set(rows.map((x) => x.reason));
    const status = await this.statuses();
    const live = this.subs.filter((s) => status.get(s.id) === "active" && !s.offline && !s.pinned);
    await this.sim.at(t, async () => {
      if (!have.has("expansion")) {
        for (const rec of live) if ((await this.upgrade(rec)) || (await this.seats(rec, 1))) break;
      }
      if (!have.has("contraction")) {
        for (const rec of [...live].reverse())
          if ((await this.downgrade(rec)) || (await this.seats(rec, -1))) break;
      }
      if (!have.has("churn")) {
        const rec = live.find((s) => status.get(s.id) === "active");
        if (rec) await this.cancel(rec, true, t);
      }
    });
  }

  /** Offline payers settle their invoices by wire/check, some in two parts. */
  private async offlinePayments(t: Date): Promise<void> {
    const offline = this.subs.filter((s) => s.offline);
    if (offline.length === 0) return;
    const rows = (await systemDb.execute(sql`
      select i.public_id, i.created_at, i.amount_due_minor
      from invoices i
      where i.business_id = ${this.sim.bizId}::uuid
        and i.customer_id in (${sql.join(
          offline.map((s) => sql`${s.customerId}::uuid`),
          sql`, `,
        )})
        and i.status in ('posted', 'payment_due', 'not_paid') and i.amount_due_minor > 0
      order by i.created_at, i.total_minor
    `)) as unknown as Array<{ public_id: string; created_at: string; amount_due_minor: string }>;
    for (const inv of rows) {
      let plan = this.offlinePlan.get(inv.public_id);
      if (!plan) {
        const due = Date.parse(inv.created_at) + this.r.int(8, 40) * DAY;
        const method = this.r.pick(["wire", "wire", "cheque"]);
        const half = Math.floor(Number(inv.amount_due_minor) / 2);
        plan = this.r.chance(0.25)
          ? [
              { at: due, amount: half, method },
              { at: due + this.r.int(10, 20) * DAY, amount: undefined, method },
            ]
          : [{ at: due, amount: undefined, method }];
        this.offlinePlan.set(inv.public_id, plan);
      }
      const step = plan[0];
      if (!step || step.at > t.getTime()) continue;
      plan.shift();
      await this.sim.at(t, async () => {
        try {
          await recordOfflinePayment({
            ...this.sim.ctx,
            invoicePublicId: inv.public_id,
            ...(step.amount ? { amountMinor: step.amount } : {}),
            method: step.method,
          });
          this.bump(step.amount ? "offline_partial" : "offline_paid");
        } catch (e) {
          this.stats.refused.offline_paid = (this.stats.refused.offline_paid ?? 0) + 1;
          if (process.env.SEED_DEBUG) console.log(`   offline refused: ${(e as Error).message}`);
        }
      });
    }
  }

  /** A partial refund or a credit note against a recent paid invoice. */
  private async creditOrRefund(t: Date): Promise<void> {
    const [inv] = (await systemDb.execute(sql`
      select i.public_id, i.total_minor, (select p.public_id from payments p where p.invoice_id = i.id and p.status = 'succeeded' order by p.created_at limit 1) as payment
      from invoices i
      where i.business_id = ${this.sim.bizId}::uuid and i.status = 'paid' and i.total_minor > 2000
        and i.created_at > ${new Date(t.getTime() - 30 * DAY).toISOString()}::timestamptz
      order by i.created_at desc, i.total_minor
      limit 1
    `)) as unknown as Array<{ public_id: string; total_minor: string; payment: string | null }>;
    if (!inv) return;
    const part = Math.max(100, Math.round(Number(inv.total_minor) * this.r.pick([0.1, 0.25, 0.5])));
    const kind = this.r.weighted({ refund: 2, balance: 2, cn_refund: 1 });
    await this.sim.at(t, async () => {
      if (kind === "refund" && inv.payment) {
        await this.attempt("refund", () =>
          this.sim.call("POST", `/payments/${inv.payment}/refund`, {
            amount_minor: part,
            reason: "Service credit",
          }),
        );
        return;
      }
      try {
        await issueCreditNote({
          ...this.sim.ctx,
          invoicePublicId: inv.public_id,
          creditMethod: kind === "cn_refund" ? "refund" : "balance",
          reason: this.r.pick([
            "Goodwill adjustment",
            "Service outage credit",
            "Billing correction",
          ]),
          items: [{ description: "Partial credit", amountMinor: part }],
        });
        this.bump(kind === "cn_refund" ? "credit_note_refund" : "credit_note_balance");
      } catch (e) {
        this.stats.refused.credit_note = (this.stats.refused.credit_note ?? 0) + 1;
        if (process.env.SEED_DEBUG) console.log(`   credit note refused: ${(e as Error).message}`);
      }
    });
  }

  private async walletGrant(t: Date): Promise<void> {
    const status = await this.statuses();
    const live = this.subs.filter((s) => status.get(s.id) === "active" && !s.pinned);
    if (live.length === 0) return;
    const rec = live[this.r.int(0, live.length - 1)]!;
    const customer = await getCustomerByPublicId(this.sim.orgId, this.sim.bizId, rec.cus);
    if (!customer) return;
    const amountMinor = this.r.pick([1000, 2500, 5000]) * (this.spec.currency === "INR" ? 20 : 1);
    await this.sim.at(t, async () => {
      if (this.r.chance(0.5)) {
        await topUpWallet({
          ...this.sim.ctx,
          customer,
          amountMinor,
          currency: this.spec.currency,
          type: "granted",
        });
        this.bump("wallet_grant");
      } else {
        await addPromotionalCredits({
          ...this.sim.ctx,
          customer,
          amountMinor,
          currency: this.spec.currency,
          description: "Referral reward",
        });
        this.bump("promo_credit");
      }
    });
  }

  /** One-off historical invoice states: a void and a write-off, once each. */
  async historicalInvoiceStates(t: Date): Promise<void> {
    await this.sim.at(t, async () => {
      if (!this.wroteOff) {
        const [inv] = (await systemDb.execute(sql`
          select public_id from invoices where business_id = ${this.sim.bizId}::uuid and status = 'not_paid'
          order by created_at limit 1
        `)) as unknown as Array<{ public_id: string }>;
        if (inv) {
          await writeOffInvoice(this.sim.orgId, this.sim.bizId, inv.public_id);
          this.wroteOff = true;
          this.bump("write_off");
        }
      }
      if (!this.voided) {
        const rec = this.subs.find((s) => s.offline);
        if (rec) {
          const { invoice } = await createManualInvoice({
            ...this.sim.ctx,
            customerId: rec.customerId,
            currency: this.spec.currency,
            lines: [
              {
                description: "Training workshop (issued in error)",
                amountMinor: BigInt(this.spec.book.setup),
                kind: "one_time",
              },
            ],
            netDays: 30,
          });
          await voidInvoice(this.sim.orgId, this.sim.bizId, invoice.publicId);
          this.voided = true;
          this.bump("void");
        }
      }
    });
  }

  /** Pending future work: scheduled downgrades, cancels and a pause. */
  async scheduleFuture(t: Date): Promise<void> {
    const status = await this.statuses();
    const live = this.subs.filter(
      (s) =>
        status.get(s.id) === "active" &&
        !s.offline &&
        !s.pinned &&
        s.interval === "month" &&
        !s.team,
    );
    await this.sim.at(t, async () => {
      let downgrades = 0;
      for (const rec of live) {
        if (downgrades >= 3) break;
        if (rec.plan !== "growth" && rec.plan !== "pro") continue;
        const s = await this.sim.call("GET", `/subscriptions/${rec.id}`);
        const planItem = (s.items as Json[]).find((i) => i.product_kind === "plan");
        const lower = PLAN_LADDER[PLAN_LADDER.indexOf(rec.plan) - 1]!;
        if (!planItem || !s.current_period_end || lower === "starter") continue;
        const ok = await this.attempt("schedule_change", () =>
          this.sim.call("POST", `/subscriptions/${rec.id}/schedule`, {
            type: "change",
            effective_at: new Date(s.current_period_end).toISOString(),
            changes: [{ item: planItem.id, price: this.cat.plan[lower].month }],
          }),
        );
        if (ok) downgrades++;
      }
      const rest = live.slice(-6);
      for (const [i, rec] of rest.entries()) {
        if (i < 2) {
          await this.attempt("schedule_cancel", () =>
            this.sim.call("POST", `/subscriptions/${rec.id}/schedule`, {
              type: "cancel",
              effective_at: new Date(t.getTime() + (12 + i * 9) * DAY).toISOString(),
            }),
          );
        } else if (i === 2) {
          await this.attempt("schedule_pause", () =>
            this.sim.call("POST", `/subscriptions/${rec.id}/schedule`, {
              type: "pause",
              effective_at: new Date(t.getTime() + 10 * DAY).toISOString(),
            }),
          );
        }
      }
      // One future-dated signup, so the `future` status has a row.
      const person = makePerson(this.r, this.spec.region, ++this.n, true);
      const customer = await createCustomer({
        ...this.sim.ctx,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        company: person.company,
        address: person.address,
      });
      await vaultPaymentMethod({ ...this.sim.ctx, customer, token: GOOD });
      await this.attempt("future_signup", () =>
        this.sim.call("POST", `/customers/${customer.publicId}/subscriptions`, {
          items: [{ price: this.cat.plan.growth.month }],
          trial_days: 0,
          start_date: new Date(t.getTime() + 14 * DAY).toISOString(),
        }),
      );
    });
  }

  /** One short progress line for a finished simulated month. */
  async monthLine(label: string): Promise<string> {
    const [row] = (await systemDb.execute(sql`
      select count(*) filter (where status in ('active', 'in_trial'))::int as live,
             coalesce(sum(mrr) filter (where status = 'active'), 0)::bigint as mrr
      from subscriptions where business_id = ${this.sim.bizId}::uuid
    `)) as unknown as Array<{ live: number; mrr: string }>;
    const signups = this.monthSignups;
    this.monthSignups = 0;
    return `${label}  +${String(signups).padStart(2)} signups  ${String(row!.live).padStart(4)} live  MRR ${money(Number(row!.mrr), this.spec.currency)}`;
  }
}
