/**
 * Named showcase records, dated at or near today, so each dashboard feature has an
 * obvious example: coupon + wallet + added add-on, multi-item + usage + unbilled charge +
 * scheduled cancel, a live dunning case, a price override, a reactivatable cancel, manual
 * invoices in every state, and GST on both sides of the place-of-supply split.
 */
import { createCustomer, getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { topUpWallet } from "@/modules/wallet/service";
import {
  createManualInvoice,
  voidInvoice,
  writeOffInvoice,
  recordOfflinePayment,
} from "@/modules/invoicing/ops";
import { issueCreditNote } from "@/modules/credit-notes/service";
import { DAY, type Json } from "./api";
import type { Lifecycle, SubRec } from "./lifecycle";
import type { Person } from "./people";

const person = (firstName: string, lastName: string, email: string): Person => ({
  firstName,
  lastName,
  email,
  address: {
    line1: "88 Harbor St",
    city: "Oakland",
    state: "California",
    stateCode: "CA",
    postalCode: "94607",
    country: "US",
  },
});

const lines = (description: string, amount: number) => [
  { description, amountMinor: BigInt(amount), kind: "one_time" },
];

export interface Showcase {
  dunning?: SubRec;
}

/** Acme, ~33 days out: a Pro customer whose renewal will fail days before today. */
export async function acmeDunningSetup(lc: Lifecycle, t: Date, state: Showcase): Promise<void> {
  const rec = await lc.signup(t, {
    plan: "pro",
    interval: "month",
    trial: null,
    coupon: null,
    seats: 0,
    metered: false,
    person: person("Jonas", "Lindqvist", "jonas@lindqvist-design.example"),
  });
  if (rec) {
    rec.pinned = true;
    state.dunning = rec;
  }
}

/** Acme, a couple of days later: the card behind it starts failing (retriable). */
export async function acmeDunningBreak(lc: Lifecycle, t: Date, state: Showcase): Promise<void> {
  if (!state.dunning) return;
  await lc.sim.at(t, () => lc.swapCard(state.dunning!, "4000000000009995", "card_insufficient"));
}

export async function acmeToday(lc: Lifecycle, t: Date): Promise<string[]> {
  const { sim, cat } = lc;
  const at = (k: number) => new Date(t.getTime() - (40 - k) * 60_000);
  const out: string[] = [];

  // Coupon at signup + wallet grant + an add-on added mid-term.
  const ada = await lc.signup(at(1), {
    plan: "growth",
    interval: "month",
    trial: null,
    coupon: "welcome",
    seats: 0,
    metered: false,
    person: person("Maya", "Okafor", "maya@okafor-studio.example"),
  });
  if (ada) {
    ada.pinned = true;
    await sim.at(at(2), async () => {
      const customer = await getCustomerByPublicId(sim.orgId, sim.bizId, ada.cus);
      await topUpWallet({
        ...sim.ctx,
        customer: customer!,
        amountMinor: 5000,
        currency: "USD",
        type: "granted",
      });
      await sim.call("POST", `/subscriptions/${ada.id}/items`, {
        price: cat.seat.month,
        quantity: 2,
      });
    });
    out.push(`Maya Okafor (${ada.id}) — WELCOME10 + wallet + added seats`);
  }

  // Multi-item + usage + unbilled one-off + scheduled cancel.
  const grace = await lc.signup(at(3), {
    plan: "pro",
    interval: "month",
    trial: null,
    coupon: null,
    seats: 3,
    metered: true,
    person: person("Priya", "Raman", "priya@raman-labs.example"),
  });
  if (grace) {
    grace.pinned = true;
    await sim.at(at(4), async () => {
      const s = await sim.call("GET", `/subscriptions/${grace.id}`);
      const meter = (s.items as Json[]).find((i) => i.price === cat.usage);
      if (meter)
        await sim.call("POST", `/subscriptions/${grace.id}/usage`, {
          item: meter.id,
          quantity: 4200,
        });
      await sim.call("POST", `/subscriptions/${grace.id}/charges`, {
        charges: [{ description: "Priority support (one-off)", amount_minor: 2500 }],
        invoice_now: false,
      });
      await sim.call("POST", `/subscriptions/${grace.id}/schedule`, {
        type: "cancel",
        effective_at: new Date(t.getTime() + 30 * DAY).toISOString(),
      });
    });
    out.push(`Priya Raman (${grace.id}) — multi-item + usage + unbilled charge + scheduled cancel`);
  }

  // Negotiated price (override badge).
  const ent = await lc.signup(at(5), {
    plan: "pro",
    interval: "month",
    trial: null,
    coupon: null,
    seats: 0,
    metered: false,
    overridePct: 75,
    company: true,
    person: {
      ...person("Idris", "Achebe", "procurement@enterprise-co.example"),
      company: "Enterprise Co",
    },
  });
  if (ent) ent.pinned = true;
  if (ent) out.push(`Enterprise Co (${ent.id}) — custom price override`);

  // Cancelled today (Reactivate action).
  const churned = await lc.signup(at(6), {
    plan: "starter",
    interval: "month",
    trial: null,
    coupon: null,
    person: person("Tomas", "Castell", "tomas.castell@example.com"),
  });
  if (churned) {
    churned.pinned = true;
    await sim.at(at(7), () =>
      sim.call("POST", `/subscriptions/${churned.id}/cancel`, {
        cancel_option: "immediately",
        cancel_reason_code: "trying_out",
      }),
    );
    out.push(`Tomas Castell (${churned.id}) — cancelled today (reactivate)`);
  }

  // Manual invoices in every state, for a customer whose address resolves US-CA tax.
  await sim.at(at(8), async () => {
    const globex = await createCustomer({
      ...sim.ctx,
      email: "billing@globex.example",
      company: "Globex Corp",
      address: {
        line1: "1 Market St",
        city: "San Francisco",
        state: "CA",
        stateCode: "CA",
        postalCode: "94105",
        country: "US",
      },
    });
    await vaultPaymentMethod({ ...sim.ctx, customer: globex, token: "tok_4242" });
    const paid = await createManualInvoice({
      ...sim.ctx,
      customerId: globex.id,
      currency: "USD",
      lines: lines("Consulting — analytics audit", 50000),
      collect: true,
      applyTax: true,
      country: "US",
      state: "CA",
      stateCode: "CA",
    });
    await issueCreditNote({
      ...sim.ctx,
      invoicePublicId: paid.invoice.publicId,
      creditMethod: "balance",
      reason: "Goodwill adjustment",
      items: [{ description: "Partial credit", amountMinor: 10000 }],
    });
    const net = await createManualInvoice({
      ...sim.ctx,
      customerId: globex.id,
      currency: "USD",
      lines: lines("Implementation — Net 30", 120000),
      netDays: 30,
    });
    await recordOfflinePayment({
      ...sim.ctx,
      invoicePublicId: net.invoice.publicId,
      amountMinor: 40000,
      method: "wire",
    });
    const dup = await createManualInvoice({
      ...sim.ctx,
      customerId: globex.id,
      currency: "USD",
      lines: lines("Duplicate charge", 3000),
    });
    await voidInvoice(sim.orgId, sim.bizId, dup.invoice.publicId);
    const bad = await createManualInvoice({
      ...sim.ctx,
      customerId: globex.id,
      currency: "USD",
      lines: lines("Uncollectible balance", 8000),
    });
    await writeOffInvoice(sim.orgId, sim.bizId, bad.invoice.publicId);
  });
  out.push(
    "Globex Corp — manual invoices: paid + credit note · Net-30 partial wire · voided · written off",
  );
  return out;
}

/** Nimbus: one GST invoice on each side of the place-of-supply split. */
export async function nimbusToday(lc: Lifecycle, t: Date): Promise<string[]> {
  const { sim } = lc;
  await sim.at(t, async () => {
    const intra = await createCustomer({
      ...sim.ctx,
      email: "ap@chennai-textiles.example",
      company: "Chennai Textiles",
      address: {
        line1: "12 Anna Salai",
        city: "Chennai",
        state: "Tamil Nadu",
        stateCode: "TN",
        postalCode: "600002",
        country: "IN",
      },
    });
    const inter = await createCustomer({
      ...sim.ctx,
      email: "finance@bengaluru-cloud.example",
      company: "Bengaluru Cloud",
      address: {
        line1: "4 MG Road",
        city: "Bengaluru",
        state: "Karnataka",
        stateCode: "KA",
        postalCode: "560001",
        country: "IN",
      },
    });
    // Tamil Nadu = home state → CGST 9% + SGST 9%; Karnataka → IGST 18%.
    await createManualInvoice({
      ...sim.ctx,
      customerId: intra.id,
      currency: "INR",
      lines: lines("Annual licence — intra-state (Tamil Nadu)", 10000000),
      applyTax: true,
    });
    await createManualInvoice({
      ...sim.ctx,
      customerId: inter.id,
      currency: "INR",
      lines: lines("Annual licence — inter-state (Karnataka)", 10000000),
      applyTax: true,
    });
  });
  return ["Chennai Textiles / Bengaluru Cloud — GST intra-state (CGST+SGST) vs inter-state (IGST)"];
}
