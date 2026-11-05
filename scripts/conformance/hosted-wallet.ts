/**
 * Rows for pay-now Apple Pay on a gateway's own hosted page (`hostedWallet`), shared by every
 * fixture whose catalogue entry sets `applePayHosted`. The buyer leaves for the gateway's
 * page, pays, and the gateway's webhook books the invoice.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import {
  createPaymentIntent,
  getPaymentIntent,
  hostedWalletMismatch,
  voidPaymentIntent,
} from "@/modules/payment-intents/service";
import { paymentAttempts, payments } from "@db/schema";
import type { FakeCall } from "./fake-http";
import { AMOUNT, type World } from "./harness";
import type { Body, ExtraRow } from "./types";

export interface HostedWalletSpec {
  /** Fake op of the hosted page's create. */
  createOp: string;
  /** Why the create request is wrong, or null. `ref` is the intent's public id. */
  checkCreate(call: FakeCall, ref: string): string | null;
  /** Prefix of the intent id the adapter stores for the page. */
  intentPrefix: string;
  /** The buyer pays on the page: the fake records the payment; the gateway's webhook bodies. */
  pay(w: World, intentAtGateway: string): { chargeId: string; bodies: Body[] };
  /** What the attempt records as the method that paid; null when the page also takes cards. */
  methodUsed: string | null;
}

const RETURN = "https://portal.example.com/portal?pay=return";

async function open(w: World) {
  const inv = await w.openInvoice();
  const { intent } = await createPaymentIntent({
    organizationId: w.org.id,
    businessId: w.biz.id,
    purpose: "payment",
    flow: "portal_payment",
    letBuyerChooseMethod: true,
    customerPublicId: inv.customerPublicId,
    gatewayAccountId: w.account.publicId,
    amountMinor: Number(AMOUNT),
    currency: w.fixture.currency,
    invoicePublicId: inv.invoicePublicId,
    session: "on_session",
    returnUrl: RETURN,
    cancelUrl: RETURN.replace("return", "cancel"),
    hostedWallet: "apple_pay",
    // Proven here offline even while it waits for live proof (`live-proof-pending.json`).
    pendingMethods: {},
  });
  return { inv, intent };
}

const paymentsOf = (w: World, invoiceId: string) =>
  withTenant(w.org.id, (tx) => tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)));

export function hostedApplePayRows(spec: HostedWalletSpec): ExtraRow[] {
  return [
    {
      scenario: "S13",
      id: "S13.hosted-applepay-request",
      title:
        "Apple Pay pay-now opens the gateway's own page, for the amount, carrying our ref; a switch to the form replaces it",
      async run({ world }) {
        const w = await world("hosted-request");
        const before = w.driver.fake.callsOf(spec.createOp).length;
        const { intent } = await open(w);
        const call = w.driver.fake.callsOf(spec.createOp)[before];
        const action = intent.nextAction as { mode?: string; approvalUrl?: string } | null;
        const wrong =
          (!call && "the gateway's page was not created") ||
          spec.checkCreate(call!, intent.publicId) ||
          (action?.mode !== "redirect" && `next action ${action?.mode}, not redirect`) ||
          (!action?.approvalUrl?.startsWith("https://") && "no https page to send the buyer to") ||
          (!intent.intentAtGateway?.startsWith(spec.intentPrefix) &&
            `intent id ${intent.intentAtGateway} lacks ${spec.intentPrefix}`) ||
          // Pay now resumes it for Apple Pay, and replaces it when the buyer picks the form.
          ((await hostedWalletMismatch(w.org.id, w.biz.id, intent, true)) &&
            "Apple Pay again does not resume the open page") ||
          (!(await hostedWalletMismatch(w.org.id, w.biz.id, intent, false)) &&
            "picking the form would resume the Apple Pay page");
        return { pass: !wrong, detail: wrong || undefined };
      },
    },
    {
      scenario: "S11",
      id: "S11.hosted-applepay-books-once",
      title:
        "the hosted page's payment webhook books the invoice once, a redelivery books nothing, and our ref comes back",
      async run({ world }) {
        const w = await world("hosted-book");
        const { inv, intent } = await open(w);
        const paid = spec.pay(w, intent.intentAtGateway!);
        const first = await w.deliver(paid.bodies);
        const again = await w.redeliver();
        const rows = await paymentsOf(w, inv.invoiceId);
        const ok = rows.filter((p) => p.status === "succeeded");
        const pi = await getPaymentIntent(w.org.id, w.biz.id, intent.publicId);
        const [attempt] = await withTenant(w.org.id, (tx) =>
          tx
            .select()
            .from(paymentAttempts)
            .where(and(eq(paymentAttempts.paymentIntentId, intent.id))),
        );
        const events = await w.eventRows(paid.bodies.flatMap((b) => b.eventIds));
        const refs = events.map(
          (e) => (e.normalized as { ownershipRef?: string } | null)?.ownershipRef,
        );
        const wrong =
          (first.status !== 200 && `webhook answered ${first.status}`) ||
          (again.status !== 200 && `redelivery answered ${again.status}`) ||
          (ok.length !== 1 && `${ok.length} succeeded payments, not 1`) ||
          (ok[0]?.providerChargeId !== paid.chargeId &&
            `booked ${ok[0]?.providerChargeId}, not ${paid.chargeId}`) ||
          (ok[0]?.amountMinor !== AMOUNT && `booked ${ok[0]?.amountMinor}`) ||
          ((await w.invoiceStatus(inv.invoiceId)) !== "paid" && "the invoice is not paid") ||
          (pi?.status !== "consumed" && `intent ${pi?.status}, not consumed`) ||
          ((attempt?.methodUsed ?? null) !== spec.methodUsed &&
            `method ${attempt?.methodUsed}, not ${spec.methodUsed}`) ||
          (!refs.includes(intent.publicId) && `ownership refs ${refs.join(",")}`) ||
          (!(await w.balanced()) && "the ledger does not balance") ||
          ((await w.cash()) !== AMOUNT && `cash ${await w.cash()}`);
        return { pass: !wrong, detail: wrong || undefined };
      },
    },
    {
      scenario: "S10",
      id: "S10.hosted-applepay-abandoned",
      title: "a hosted page the buyer leaves unpaid books nothing and closes when voided",
      async run({ world }) {
        const w = await world("hosted-abandon");
        const { inv, intent } = await open(w);
        const voided = await voidPaymentIntent(w.org.id, w.biz.id, intent.publicId);
        // The invoice was issued with no payment method, which leaves a failed attempt.
        const rows = (await paymentsOf(w, inv.invoiceId)).filter((p) => p.status !== "failed");
        const wrong =
          (voided?.intent.status !== "voided" && `intent ${voided?.intent.status}`) ||
          (rows.length > 0 && `${rows.length} payment rows`) ||
          ((await w.cash()) !== 0n && `cash ${await w.cash()}`) ||
          ((await w.invoiceStatus(inv.invoiceId)) === "paid" && "the invoice is paid") ||
          (!(await w.balanced()) && "the ledger does not balance");
        return { pass: !wrong, detail: wrong || undefined };
      },
    },
  ];
}
