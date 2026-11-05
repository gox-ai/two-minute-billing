/**
 * verify:braintree — the Braintree adapter, offline. No network: GraphQL answers come from a
 * stubbed `fetch`, in the shapes the sandbox returned (measured by `verify:braintree-live`).
 *
 * Covers webhook signatures, notification parsing and normalisation, decline mapping, the
 * charge initiator, capabilities, and the `sdk` intent flow.
 *
 *   pnpm verify:braintree
 */
import { closeDb } from "@/platform/db";
import {
  BraintreeProvider,
  braintreeOfferedMethods,
  braintreePaymentInitiator,
  braintreeThreeDSecureFailure,
  changedCardTokens,
  chargeResultFromTransaction,
  decodeBraintreeNotification,
  decodeSyntheticIntent,
  encodeSyntheticIntent,
  normalizeBraintreeNotification,
  parseMerchantAccounts,
  parseXml,
  signBraintreePayload,
  transactionGlobalId,
  verifyBraintreeSignature,
  type BtTransaction,
} from "@/providers/braintree";
import { DECLINE_SETS, normalizeBraintreeDecline } from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES } from "@/providers/gateways";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  strandedObjectId,
  type NormalizedProviderEvent,
} from "@/providers/types";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const throws = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

const PUB = "pk_offline_test";
const PRIV = "private_offline_test";

/** A delivery as Braintree posts it: form-encoded, base64 XML with a trailing newline. */
function delivery(xml: string, opts: { pub?: string; priv?: string; payload?: string } = {}) {
  const payload = opts.payload ?? `${Buffer.from(xml).toString("base64")}\n`;
  return new URLSearchParams({
    bt_signature: signBraintreePayload(opts.pub ?? PUB, opts.priv ?? PRIV, payload),
    bt_payload: payload,
  }).toString();
}

const notification = (kind: string, subject: string, ts = "2026-10-24T10:00:00Z") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<notification>\n  <timestamp type="datetime">${ts}</timestamp>\n  <kind>${kind}</kind>\n  <subject>${subject}</subject>\n</notification>`;

const dispute = (status: string, kind = "chargeback", id = "dsp0001") => `<dispute>
  <amount>250.00</amount>
  <amount-disputed>250.0</amount-disputed>
  <currency-iso-code>USD</currency-iso-code>
  <received-date type="date">2026-10-01</received-date>
  <reply-by-date type="date">2026-10-21</reply-by-date>
  <kind>${kind}</kind>
  <status>${status}</status>
  <reason>fraud</reason>
  <id>${id}</id>
  <transaction><id>txn0001</id><amount>250.00</amount></transaction>
</dispute>`;

const transaction = (
  status: string,
  extra = "",
  id = "txn0001",
) => `<transaction><id>${id}</id><status>${status}</status><type>sale</type>
  <currency-iso-code>USD</currency-iso-code><amount>100.00</amount>${extra}</transaction>`;

// ── 1. Signatures ───────────────────────────────────────────────────────────
console.log("signatures");
{
  const xml = notification("check", '<check type="boolean">true</check>');
  const payload = `${Buffer.from(xml).toString("base64")}\n`;
  const sig = signBraintreePayload(PUB, PRIV, payload);
  ok(
    "a valid signature verifies",
    (await throws(() => verifyBraintreeSignature(PUB, PRIV, sig, payload))) === null,
  );
  // Braintree signs with or without the trailing newline.
  const bare = payload.trimEnd();
  ok(
    "a signature over the payload plus a newline also verifies",
    (await throws(() =>
      verifyBraintreeSignature(PUB, PRIV, signBraintreePayload(PUB, PRIV, `${bare}\n`), bare),
    )) === null,
  );
  const tampered = Buffer.from(xml.replace("check", "dispute_won")).toString("base64");
  ok(
    "a tampered payload is refused",
    (await throws(() => verifyBraintreeSignature(PUB, PRIV, sig, tampered))) instanceof Error,
  );
  ok(
    "a signature made with another private key is refused",
    (await throws(() =>
      verifyBraintreeSignature(
        PUB,
        PRIV,
        signBraintreePayload(PUB, "someone_else", payload),
        payload,
      ),
    )) instanceof Error,
  );
  ok(
    "a signature for another public key is refused",
    (await throws(() =>
      verifyBraintreeSignature(PUB, PRIV, signBraintreePayload("pk_other", PRIV, payload), payload),
    )) instanceof Error,
  );
  ok(
    "a pair list finds the pair for our public key",
    (await throws(() =>
      verifyBraintreeSignature(PUB, PRIV, `pk_other|deadbeef&${sig}`, payload),
    )) === null,
  );
  ok(
    "a payload with characters outside base64 is refused",
    (await throws(() => verifyBraintreeSignature(PUB, PRIV, sig, `${payload}<x>`))) instanceof
      Error,
  );
}

// ── 2. Parsing and normalisation ────────────────────────────────────────────
console.log("parsing and normalisation");
const adapter = new BraintreeProvider({
  merchantId: "m",
  publicKey: PUB,
  privateKey: PRIV,
  livemode: false,
});
const normalize = (xml: string) =>
  adapter.normalizeWebhook({
    payload: delivery(xml),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
{
  const doc = parseXml('<a x="1"><b nil="true"/><c>Tom &amp; Jerry &#38; &lt;co&gt;</c></a>');
  ok(
    "the XML reader decodes entities and attributes",
    doc.children[1]?.text === "Tom & Jerry & <co>" && doc.attrs.x === "1",
  );
  ok("malformed XML is refused", (await throws(() => parseXml("<a><b></a>"))) instanceof Error);

  const opened = await normalize(notification("dispute_opened", dispute("open")));
  ok(
    "a chargeback opening is a dispute plus a funds withdrawal",
    opened.map((e) => e.type).join(",") === "dispute.created,dispute.funds_withdrawn",
  );
  const d = opened[0]!;
  ok(
    "the dispute carries id, the legacy transaction id, amount in minor units and the reply-by date",
    d.providerDisputeId === "dsp0001" &&
      d.providerChargeId === "txn0001" &&
      d.disputeAmountMinor === 25_000n &&
      d.disputeCurrency === "USD" &&
      d.disputeReason === "fraud" &&
      d.evidenceDueBy?.toISOString().startsWith("2026-10-21") === true,
  );
  ok(
    "every event of one delivery carries the delivery's id",
    opened.every((e) => e.providerEventId === opened[0]!.providerEventId),
  );
  const retrieval = await normalize(notification("dispute_opened", dispute("open", "retrieval")));
  ok(
    "a retrieval request withdraws nothing",
    retrieval.length === 1 && retrieval[0]!.type === "dispute.created",
  );
  const kinds: [string, string, NormalizedProviderEvent["type"]][] = [
    ["dispute_won", "won", "dispute.won"],
    ["dispute_lost", "lost", "dispute.lost"],
    ["dispute_accepted", "accepted", "dispute.lost"],
    ["dispute_auto_accepted", "auto_accepted", "dispute.lost"],
    ["dispute_expired", "expired", "dispute.lost"],
    ["dispute_under_review", "under_review", "dispute.created"],
    ["dispute_disputed", "disputed", "dispute.created"],
  ];
  for (const [kind, status, want] of kinds) {
    const evs = await normalize(notification(kind, dispute(status)));
    ok(
      `${kind} → ${want}`,
      evs.length === 1 && evs[0]!.type === want && evs[0]!.disputeStatus === status,
    );
  }

  const settled = await normalize(
    notification(
      "transaction_settled",
      transaction("settled", "<order-id>tmbilling_ref:inv_XXXXXXXX01</order-id>"),
    ),
  );
  ok(
    "transaction_settled → charge.succeeded on the legacy id, ours by order id",
    settled[0]?.type === "charge.succeeded" &&
      settled[0].providerChargeId === "txn0001" &&
      settled[0].ownership === "ours" &&
      settled[0].ownershipRef === "inv_XXXXXXXX01",
  );
  ok(
    "capturedAmountMinor: a settled transaction carries its amount",
    settled[0]?.capturedAmountMinor === 10000n,
  );
  const yen = await normalize(
    notification(
      "transaction_settled",
      `<transaction><id>txn0002</id><status>settled</status><type>sale</type>
  <currency-iso-code>JPY</currency-iso-code><amount>1500</amount></transaction>`,
    ),
  );
  ok(
    "capturedAmountMinor: in the currency's own minor units (JPY has none)",
    yen[0]?.capturedAmountMinor === 1500n,
  );
  const foreign = await normalize(
    notification("transaction_settled", transaction("settled", "<order-id>ORDER-7</order-id>")),
  );
  ok("a transaction with another order id is foreign", foreign[0]?.ownership === "foreign");
  const untagged = await normalize(notification("transaction_settled", transaction("settled")));
  ok(
    "a transaction with no order id field is unknown, not foreign",
    untagged[0]?.ownership === "unknown",
  );

  const declined = await normalize(
    notification(
      "transaction_settlement_declined",
      transaction(
        "settlement_declined",
        "<processor-settlement-response-code>4001</processor-settlement-response-code><processor-settlement-response-text>Settlement Declined</processor-settlement-response-text>",
      ),
    ),
  );
  ok(
    "settlement declined → charge.failed with the same decline vocabulary",
    declined[0]?.lateReversal === true &&
      declined[0]?.type === "charge.failed" &&
      declined[0].failureCode === "card_declined" &&
      declined[0].providerFailureCode === "4001" &&
      declined[0].failureRetriable === true,
  );
  const creditDeclined = await normalize(
    notification(
      "transaction_settlement_declined",
      "<transaction><id>rf0001</id><status>settlement_declined</status><type>credit</type></transaction>",
    ),
  );
  ok(
    "a declined refund settlement → refund.failed",
    creditDeclined[0]?.type === "refund.failed" && creditDeclined[0].providerRefundId === "rf0001",
  );
  const refundFailed = await normalize(
    notification(
      "refund_failed",
      "<transaction><id>rf0002</id><status>processor_declined</status><refunded-transaction-fk>1</refunded-transaction-fk></transaction>",
    ),
  );
  ok(
    "refund_failed → refund.failed",
    refundFailed[0]?.type === "refund.failed" && refundFailed[0].providerRefundId === "rf0002",
  );
  const settledCredit = await normalize(
    notification(
      "transaction_settled",
      "<transaction><id>rf0003</id><status>settled</status><type>credit</type></transaction>",
    ),
  );
  ok("a settled REFUND is not booked as a charge", settledCredit[0]?.type === "unknown");

  // Dispute kinds and partial wins.
  const expired = await normalize(notification("dispute_expired", dispute("expired", "retrieval")));
  ok(
    "a retrieval that expires closes, never lost (its funds never left)",
    expired.length === 1 && expired[0]!.type === "dispute.closed",
  );
  const cbExpired = await normalize(notification("dispute_expired", dispute("expired")));
  ok("a chargeback that expires is still lost", cbExpired[0]?.type === "dispute.lost");
  const preArb = await normalize(
    notification("dispute_opened", dispute("open", "pre_arbitration")),
  );
  ok(
    "a pre-arbitration opening withdraws the funds, like a chargeback",
    preArb.map((e) => e.type).join(",") === "dispute.created,dispute.funds_withdrawn",
  );
  const partWin = await normalize(
    notification(
      "dispute_won",
      dispute("won").replace("<kind>", "<amount-won>150.00</amount-won><kind>"),
    ),
  );
  ok(
    "amount-won is the amount reinstated",
    partWin[0]?.type === "dispute.won" && partWin[0].disputeAmountWonMinor === 15_000n,
  );
  const fullWin = await normalize(notification("dispute_won", dispute("won")));
  ok("no amount-won reinstates it all", fullWin[0]?.disputeAmountWonMinor === undefined);

  // A refund's settlement names its sale: charge.refunded, one record per refund.
  const credit = normalizeBraintreeNotification(
    decodeBraintreeNotification(
      Buffer.from(
        notification(
          "transaction_settled",
          "<transaction><id>rf0004</id><status>settled</status><type>credit</type>" +
            "<currency-iso-code>USD</currency-iso-code><amount>30.00</amount>" +
            "<order-id>tmbilling_ref:re_X</order-id><refunded-transaction-id>txn0001</refunded-transaction-id></transaction>",
        ),
      ).toString("base64"),
    ),
    "evt",
    {},
  );
  ok(
    "a settled refund → charge.refunded on its sale, with its own amount and our tag",
    credit[0]?.type === "charge.refunded" &&
      credit[0].providerChargeId === "txn0001" &&
      credit[0].refunds?.[0]?.providerRefundId === "rf0004" &&
      credit[0].refunds[0].amountMinor === 3000n &&
      credit[0].refunds[0].status === "succeeded" &&
      credit[0].refunds[0].ownershipRef === "re_X",
  );
  const reviewed = await normalize(
    notification(
      "transaction_reviewed",
      "<transaction-review><transaction-id>txn0009</transaction-id><decision>approved</decision></transaction-review>",
    ),
  );
  ok(
    "transaction_reviewed → review.closed",
    reviewed[0]?.type === "review.closed" && reviewed[0].providerChargeId === "txn0009",
  );
  const check = await normalize(notification("check", '<check type="boolean">true</check>'));
  ok(
    "the Control Panel's check is recorded as unknown",
    check.length === 1 && check[0]!.type === "unknown",
  );
  const sub = await normalize(
    notification("subscription_charged_successfully", "<subscription><id>s1</id></subscription>"),
  );
  ok("Braintree subscription events are never acted on", sub[0]?.type === "unknown");

  ok(
    "a forged delivery is refused by normalizeWebhook",
    (await throws(() =>
      adapter.normalizeWebhook({
        payload: delivery(notification("dispute_won", dispute("won")), { priv: "forged" }),
        headers: {},
      }),
    )) instanceof Error,
  );

  // Dedupe id: stable on a redelivery, different for another subject or another moment.
  const body = delivery(notification("dispute_won", dispute("won")));
  const id1 = adapter.webhookEventId({ payload: body, headers: {} });
  ok(
    "a redelivery keeps its event id",
    adapter.webhookEventId({ payload: body, headers: {} }) === id1,
    id1,
  );
  ok(
    "another dispute in the same second gets another id",
    adapter.webhookEventId({
      payload: delivery(notification("dispute_won", dispute("won", "chargeback", "dsp0002"))),
      headers: {},
    }) !== id1,
  );
  ok(
    "the same dispute at a later time gets another id",
    adapter.webhookEventId({
      payload: delivery(notification("dispute_won", dispute("won"), "2026-10-24T10:00:01Z")),
      headers: {},
    }) !== id1,
  );
  const n = decodeBraintreeNotification(
    `${Buffer.from(notification("check", "<check>true</check>")).toString("base64")}\n`,
  );
  const direct = normalizeBraintreeNotification(n, "x", null);
  ok("the pure normaliser needs no adapter", direct[0]?.providerEventId === "x");
}

// ── 3. Declines ─────────────────────────────────────────────────────────────
console.log("declines");
{
  const cases: [string, string, boolean][] = [
    ["2000", "do_not_honor", true],
    ["2001", "insufficient_funds", true],
    ["2004", "expired_card", false],
    ["2005", "incorrect_number", true],
    ["2010", "incorrect_cvc", true],
    ["2012", "lost_card", false],
    ["2013", "stolen_card", false],
    ["2014", "fraudulent", false],
    ["2017", "revocation_of_authorization", false],
    ["2043", "network_do_not_retry", false],
    ["2047", "pickup_card", false],
    ["2108", "payment_method_not_found", false],
    ["3000", "processing_error", true],
    ["4001", "card_declined", true],
    ["APPLICATION_INCOMPLETE", "gateway_request_rejected", false],
    ["CVV", "incorrect_cvc", true],
    ["RISK_THRESHOLD", "card_declined", true],
    ["91518", "payment_method_not_found", false],
  ];
  for (const [raw, code, retriable] of cases) {
    const f = normalizeBraintreeDecline(raw);
    ok(
      `${raw} → ${code} (retriable=${retriable})`,
      f.code === code && f.retriable === retriable,
      JSON.stringify(f),
    );
  }
  const unknown = normalizeBraintreeDecline("2999");
  ok("an unmapped code passes through, retriable", unknown.code === "2999" && unknown.retriable);
  ok(
    "a merchant-setup refusal is hidden from the payer",
    normalizeBraintreeDecline("2026").exposedToPayer === false,
  );
  const pending = normalizeBraintreeDecline("2081");
  ok(
    "2081 PayPal pending payments not supported: our setup, not retriable, hidden from the payer",
    pending.code === "gateway_request_rejected" &&
      pending.retriable === false &&
      pending.exposedToPayer === false &&
      /Contact Braintree support/.test(pending.message ?? ""),
  );
  ok(
    "PayPal account refusals: revoked agreement and closed payer account are hard declines",
    normalizeBraintreeDecline("2070").code === "revocation_of_authorization" &&
      !normalizeBraintreeDecline("2070").retriable &&
      normalizeBraintreeDecline("2075").code === "payment_method_not_found" &&
      !normalizeBraintreeDecline("2075").retriable,
  );
  ok(
    "PayPal business-account refusals (2063–2100) are ours, never retried",
    ["2063", "2066", "2068", "2079", "2087", "2088", "2091", "2100"].every((c) => {
      const d = normalizeBraintreeDecline(c);
      return d.code === "gateway_request_rejected" && !d.retriable && d.exposedToPayer === false;
    }),
  );

  // Shapes measured on the sandbox (amounts 2000.00, 2004.00, 5001.00, 3000.00).
  const declined: BtTransaction = {
    id: "dHJhbnNhY3Rpb25fYmJ4ZjRhcnA",
    legacyId: "bbxf4arp",
    status: "PROCESSOR_DECLINED",
    paymentMethodSnapshot: { creditCard: { brandCode: "VISA" } },
    processorAuthorizationResponse: { legacyCode: "2004", message: "Expired Card" },
    statusHistory: [
      {
        __typename: "ProcessorDeclinedEvent",
        status: "PROCESSOR_DECLINED",
        declineType: "HARD",
        processorResponse: { legacyCode: "2004", message: "Expired Card" },
        networkResponse: { code: "54", message: null },
      },
    ],
  };
  const r = chargeResultFromTransaction(declined);
  ok(
    "a processor decline → failed, keyed on the legacy id",
    r.status === "failed" &&
      r.providerChargeId === "bbxf4arp" &&
      r.failure?.code === "expired_card" &&
      r.failure.providerCode === "2004" &&
      r.failure.retriable === false,
  );
  const rejected = chargeResultFromTransaction({
    id: "x",
    legacyId: "kh82ynak",
    status: "GATEWAY_REJECTED",
    statusHistory: [
      { status: "GATEWAY_REJECTED", gatewayRejectionReason: "APPLICATION_INCOMPLETE" },
    ],
  });
  ok(
    "a gateway rejection reads the rejection reason",
    rejected.failure?.code === "gateway_request_rejected",
  );
  const failed = chargeResultFromTransaction({
    id: "x",
    legacyId: "6q4h10b2",
    status: "FAILED",
    statusHistory: [
      {
        status: "FAILED",
        processorResponse: {
          legacyCode: "3000",
          message: "Processor Network Unavailable - Try Again",
        },
      },
    ],
  });
  ok(
    "a processor outage is a retriable processing error",
    failed.failure?.code === "processing_error" && failed.failure.retriable,
  );
  ok(
    "a sale submitted for settlement has succeeded",
    chargeResultFromTransaction({ id: "x", legacyId: "a", status: "SUBMITTED_FOR_SETTLEMENT" })
      .status === "succeeded",
  );
  ok(
    "an authorization not yet captured is pending",
    chargeResultFromTransaction({ id: "x", legacyId: "a", status: "AUTHORIZED" }).status ===
      "pending",
  );
  const used = (__typename?: string) =>
    chargeResultFromTransaction({
      id: "x",
      legacyId: "a",
      status: "SETTLED",
      paymentMethodSnapshot: { __typename },
    }).methodUsed;
  ok(
    "methodUsed: the snapshot's type names what paid; unknown stays unknown",
    used("CreditCardTransactionDetails") === "card" &&
      used("PayPalTransactionDetails") === "paypal" &&
      used("UsBankAccountTransactionDetails") === "us_bank_account" &&
      used("LocalPaymentDetails") === undefined &&
      used(undefined) === undefined,
  );
}

// ── 4. Initiator ────────────────────────────────────────────────────────────
console.log("initiator");
ok(
  "unknown initiator → UNSCHEDULED (stored card, no buyer)",
  braintreePaymentInitiator(undefined) === "UNSCHEDULED",
);
ok(
  "clock renewal → RECURRING",
  braintreePaymentInitiator({ by: "merchant", recurring: true }) === "RECURRING",
);
ok(
  "top-up / one-off collection → UNSCHEDULED",
  braintreePaymentInitiator({ by: "merchant", recurring: false }) === "UNSCHEDULED",
);
ok(
  "buyer starts a subscription → RECURRING_FIRST",
  braintreePaymentInitiator({ by: "customer", recurring: true }) === "RECURRING_FIRST",
);
ok(
  "buyer pays once → no flag",
  braintreePaymentInitiator({ by: "customer", recurring: false }) === undefined,
);

// ── 5. Capabilities, catalog, ids ───────────────────────────────────────────
console.log("capabilities");
{
  const c = adapter.capabilities;
  ok("cards, PayPal and Venmo", c.methods.join() === "card,paypal,venmo");
  ok(
    "Venmo is bound to USD in the catalogue",
    GATEWAYS.braintree.currencyBoundMethods?.venmo === "USD",
  );
  ok("no merchant accounts → USD on the default account", c.currencies.join() === "USD");
  ok(
    "refunds, partial refunds, both intent purposes and a true void",
    c.refunds &&
      c.partialRefunds &&
      c.intents === true &&
      c.intentPurposes?.join() === "payment,setup" &&
      c.intentVoid === true,
  );
  ok("no mandate model on a vaulted card", c.mandates === false);
  ok(
    "a settlement report every hour over at most 24 h, and a poll to read it",
    c.settlementReport?.intervalMinutes === 60 &&
      c.settlementReport.maxWindowHours === 24 &&
      typeof adapter.pollSettlements === "function",
  );
  const multi = parseMerchantAccounts("USD=fernhill_usd, eur=fernhill_eur");
  ok(
    "a currency map is parsed and upper-cased",
    multi.get("USD") === "fernhill_usd" && multi.get("EUR") === "fernhill_eur",
  );
  ok("a bare currency names the default account", parseMerchantAccounts("GBP").get("GBP") === null);
  ok(
    "a malformed entry is refused",
    (await throws(() => parseMerchantAccounts("=acme"))) instanceof Error,
  );
  const built = GATEWAY_FACTORIES.braintree.build(
    {
      merchant_id: "m",
      public_key: PUB,
      private_key: PRIV,
      merchant_accounts: "USD, EUR=fernhill_eur",
    },
    { businessId: "b", livemode: false },
  );
  ok("the factory reads merchant_accounts", built.capabilities.currencies.join() === "USD,EUR");
  ok(
    "the factory refuses missing keys",
    (await throws(() =>
      GATEWAY_FACTORIES.braintree.build({ merchant_id: "m" }, { businessId: "b", livemode: false }),
    )) instanceof Error,
  );
  const def = GATEWAYS.braintree;
  ok("webhooks are signed with the API keys (url_only)", def.webhook.secret === "credential");
  ok(
    "the catalog advertises what the adapter declares",
    def.advertisedMethods.join() === c.methods.join(),
  );
  ok("its decline set is registered", DECLINE_SETS.braintree.rules.length > 0);
  ok(
    "ids are mapped to global ids as the sandbox does",
    transactionGlobalId("mevr793p") === "dHJhbnNhY3Rpb25fbWV2cjc5M3A",
  );
  const syn = encodeSyntheticIntent({
    p: "payment",
    c: "Y3VzdG9tZXJfMQ",
    a: "1999",
    cur: "USD",
    r: "inv_X",
    k: "abc",
  });
  const back = decodeSyntheticIntent(syn);
  ok(
    "a pending challenge id round-trips",
    back?.a === "1999" && back.cur === "USD" && back.r === "inv_X",
  );
  ok("a transaction id is not a pending challenge", decodeSyntheticIntent("mevr793p") === null);
}

// ── 6. The sdk flow and money calls, against a stubbed GraphQL ──────────────
console.log("sdk flow (stubbed GraphQL)");
{
  const calls: { op: string; vars: Record<string, unknown> }[] = [];
  let answer: (op: string, vars: Record<string, unknown>) => unknown = () => ({ data: null });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const op = /(?:mutation|query)[^{]*\{\s*(\w+)/.exec(body.query)?.[1] ?? "?";
    calls.push({ op, vars: body.variables ?? {} });
    return new Response(JSON.stringify(answer(op, body.variables ?? {})), { status: 200 });
  }) as typeof fetch;
  const bt = new BraintreeProvider({
    merchantId: "m",
    publicKey: PUB,
    privateKey: PRIV,
    livemode: false,
    merchantAccounts: "USD=fernhill_usd",
  });
  const customer = { providerKey: "braintree" as const, providerCustomerId: "Y3VzdG9tZXJfMQ" };
  const tx = (status: string, legacyId = "t1"): BtTransaction => ({
    id: transactionGlobalId(legacyId),
    legacyId,
    status,
    amount: { value: "19.99", currencyCode: "USD" },
  });

  try {
    answer = (op) =>
      op === "createClientToken"
        ? { data: { createClientToken: { clientToken: "ctok" } } }
        : { data: null };
    const setup = await bt.createIntent({
      purpose: "setup",
      currency: "USD",
      customer,
      idempotencyKey: "pi_s_1",
      ownershipRef: "pi_s",
    });
    ok(
      "a setup intent is an sdk challenge carrying a client token",
      setup.status === "requires_action" &&
        setup.authorization?.mode === "sdk" &&
        setup.authorization.sdk?.provider === "braintree" &&
        setup.authorization.sdk.params.clientToken === "ctok",
    );
    ok(
      "the client token names the currency's merchant account and no customer",
      JSON.stringify(calls.at(-1)?.vars) ===
        JSON.stringify({ input: { clientToken: { merchantAccountId: "fernhill_usd" } } }),
    );

    answer = () => ({
      data: {
        vaultPaymentMethod: {
          paymentMethod: {
            id: "cGF5bWVudG1ldGhvZF9jY19hYmM",
            legacyId: "abc",
            customer: { id: customer.providerCustomerId },
            details: {
              __typename: "CreditCardDetails",
              brandCode: "VISA",
              last4: "1881",
              expirationMonth: "12",
              expirationYear: "2030",
            },
          },
          verification: {
            status: "VERIFIED",
            processorResponse: { legacyCode: "1000", cvvResponse: "MATCHES" },
          },
        },
      },
    });
    const vaulted = await bt.submitClientResult!({
      intentId: setup.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-valid-nonce" },
      idempotencyKey: "k1",
    });
    ok(
      "the nonce is vaulted and the card becomes the intent's gateway id",
      vaulted.status === "authorized" && vaulted.gatewayIntentId === "cGF5bWVudG1ldGhvZF9jY19hYmM",
    );
    const vaultVars = calls.at(-1)?.vars as {
      input: { customerId?: string; paymentMethodId?: string; verification?: unknown };
    };
    ok(
      "vaulting verifies the card for the customer the intent named",
      vaultVars.input.customerId === customer.providerCustomerId &&
        vaultVars.input.paymentMethodId === "fake-valid-nonce" &&
        vaultVars.input.verification != null,
    );

    answer = () => ({
      data: {
        vaultPaymentMethod: {
          paymentMethod: null,
          verification: {
            status: "PROCESSOR_DECLINED",
            processorResponse: { legacyCode: "2000", message: "Do Not Honor" },
          },
        },
      },
    });
    const refusedSetup = await bt.submitClientResult!({
      intentId: setup.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-processor-declined-visa-nonce" },
      idempotencyKey: "k2",
    });
    ok(
      "a card that fails verification fails the setup with a normalized code",
      refusedSetup.status === "failed" && refusedSetup.failure?.code === "do_not_honor",
    );

    answer = () => ({
      errors: [
        {
          message: "Unknown or expired single-use payment method.",
          extensions: {
            errorClass: "VALIDATION",
            legacyCode: "91565",
            inputPath: ["input", "paymentMethodId"],
          },
        },
      ],
      data: { vaultPaymentMethod: null },
    });
    const badNonce = await bt.submitClientResult!({
      intentId: setup.intentId,
      purpose: "setup",
      clientResult: { nonce: "used" },
      idempotencyKey: "k3",
    });
    ok(
      "a spent nonce is a failed submission, not a crash",
      badNonce.status === "failed" && badNonce.failure?.code === "invalid_client_result",
    );
    const noNonce = await bt.submitClientResult!({
      intentId: setup.intentId,
      purpose: "setup",
      clientResult: {},
      idempotencyKey: "k4",
    });
    ok("no nonce at all is refused without a call", noNonce.status === "failed");

    answer = (op) =>
      op === "createClientToken"
        ? { data: { createClientToken: { clientToken: "ctok" } } }
        : { data: null };
    const pay = await bt.createIntent({
      purpose: "payment",
      amountMinor: 1999n,
      currency: "USD",
      customer,
      idempotencyKey: "pi_p_1",
      ownershipRef: "inv_P",
    });
    ok(
      "a pay-now intent hands the buyer the amount to show",
      pay.status === "requires_action" && pay.authorization?.sdk?.params.amount === "19.99",
    );
    answer = () => ({ data: { authorizePaymentMethod: { transaction: tx("AUTHORIZED") } } });
    const authorized = await bt.submitClientResult!({
      intentId: pay.intentId,
      purpose: "payment",
      clientResult: { nonce: "fake-valid-nonce" },
      idempotencyKey: "pi_client_1",
    });
    const authVars = calls.at(-1)?.vars as {
      input: { apiRequestKey: string; transaction: Record<string, unknown> };
    };
    ok(
      "the nonce authorizes the intent's amount and the transaction becomes its id",
      authorized.status === "authorized" &&
        authorized.gatewayIntentId === "t1" &&
        authorized.amountMinor === 1999n,
    );
    ok(
      "the authorization is idempotent, tagged and on the right account",
      authVars.input.apiRequestKey === "pi_client_1" &&
        authVars.input.transaction.amount === "19.99" &&
        authVars.input.transaction.orderId === "tmbilling_ref:inv_P" &&
        authVars.input.transaction.merchantAccountId === "fernhill_usd" &&
        authVars.input.transaction.paymentInitiator === undefined,
    );

    answer = () => ({
      data: { captureTransaction: { transaction: tx("SUBMITTED_FOR_SETTLEMENT") } },
    });
    const captured = await bt.consumeIntent({
      intentId: "t1",
      idempotencyKey: "cap1",
      purpose: "payment",
    });
    ok(
      "consuming captures the authorization",
      captured.purpose === "payment" &&
        captured.charge.status === "succeeded" &&
        captured.charge.providerChargeId === "t1",
    );
    ok(
      "the capture addresses the global id",
      (calls.at(-1)!.vars as { input: { transactionId: string } }).input.transactionId ===
        transactionGlobalId("t1"),
    );

    ok(
      "voiding an unused challenge releases nothing",
      JSON.stringify(await bt.voidIntent({ intentId: pay.intentId, idempotencyKey: "v0" })) ===
        JSON.stringify({ voided: true, held: false }),
    );
    answer = (op) =>
      op === "node"
        ? { data: { node: tx("AUTHORIZED") } }
        : { data: { voidTransaction: { transaction: { legacyId: "t1", status: "VOIDED" } } } };
    const voided = await bt.voidIntent({ intentId: "t1", idempotencyKey: "v1" });
    ok(
      "voiding an authorization reports that money was held",
      voided.voided && voided.held === true,
    );

    answer = (op) =>
      op === "node"
        ? {
            data: {
              node: {
                id: "cGF5bWVudG1ldGhvZF9jY19hYmM",
                customer: { id: customer.providerCustomerId },
                details: {
                  __typename: "CreditCardDetails",
                  brandCode: "MASTERCARD",
                  last4: "4444",
                },
              },
            },
          }
        : { data: null };
    const harvested = await bt.consumeIntent({
      intentId: "cGF5bWVudG1ldGhvZF9jY19hYmM",
      idempotencyKey: "c2",
      purpose: "setup",
    });
    ok(
      "consuming a setup returns the vaulted card",
      harvested.purpose === "setup" &&
        harvested.paymentMethod?.display.brand === "mastercard" &&
        harvested.paymentMethod.providerCustomerId === customer.providerCustomerId,
    );

    // Off-session charge.
    answer = () => ({
      data: { chargePaymentMethod: { transaction: tx("SUBMITTED_FOR_SETTLEMENT", "t2") } },
    });
    const pm = {
      providerKey: "braintree" as const,
      providerPaymentMethodId: "cGF5bWVudG1ldGhvZF9jY19hYmM",
      display: { type: "card" as const },
    };
    const charged = await bt.charge({
      amountMinor: 1000n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "inv_X_attempt_1_pm_1",
      ownershipRef: "inv_X",
      initiator: { by: "merchant", recurring: true },
    });
    const chVars = calls.at(-1)?.vars as {
      input: { apiRequestKey: string; transaction: Record<string, unknown> };
    };
    ok(
      "a renewal charge succeeds and is flagged RECURRING",
      charged.status === "succeeded" && chVars.input.transaction.paymentInitiator === "RECURRING",
    );
    ok(
      "the charge carries the idempotency key and our tag",
      chVars.input.apiRequestKey === "inv_X_attempt_1_pm_1" &&
        chVars.input.transaction.orderId === "tmbilling_ref:inv_X",
    );
    const nCalls = calls.length;
    const eur = await throws(() =>
      bt.charge({
        amountMinor: 1000n,
        currency: "EUR",
        customer,
        paymentMethod: pm,
        idempotencyKey: "k",
      }),
    );
    ok(
      "a currency with no merchant account is refused before any call",
      eur instanceof ProviderRefusalError && calls.length === nCalls,
    );

    answer = () => ({
      errors: [
        {
          message: "A previous request with this apiRequestKey is still in-flight.",
          extensions: { errorClass: "VALIDATION", legacyCode: "915233" },
        },
      ],
      data: { chargePaymentMethod: null },
    });
    ok(
      "a request still in flight is indeterminate",
      (await throws(() =>
        bt.charge({
          amountMinor: 1000n,
          currency: "USD",
          customer,
          paymentMethod: pm,
          idempotencyKey: "k",
        }),
      )) instanceof ProviderIndeterminateError,
    );
    answer = () => ({
      errors: [
        {
          message:
            "An apiRequestKey may only be reused with parameters identical to original request.",
          extensions: {
            errorClass: "VALIDATION",
            legacyCode: "915232",
            atMostOnceProcessing: { id: transactionGlobalId("t9"), legacyId: "t9" },
          },
        },
      ],
      data: { chargePaymentMethod: null },
    });
    const conflict = await throws(() =>
      bt.charge({
        amountMinor: 1000n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey: "k",
      }),
    );
    ok(
      "a key reused with other parameters throws and names the transaction it hit",
      conflict instanceof Error && strandedObjectId(conflict) === "t9",
    );
    answer = () => ({
      errors: [
        {
          message: "Multi-use payment method ID is invalid or could not be found.",
          extensions: {
            errorClass: "VALIDATION",
            legacyCode: "91518",
            inputPath: ["input", "paymentMethodId"],
          },
        },
      ],
      data: { chargePaymentMethod: null },
    });
    const gone = await bt.charge({
      amountMinor: 1000n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "k5",
    });
    ok(
      "a card deleted at Braintree is a hard decline, not a crash",
      gone.status === "failed" &&
        gone.failure?.code === "payment_method_not_found" &&
        gone.failure.retriable === false,
    );
    answer = () => ({
      errors: [
        {
          message: "Something we never saw.",
          extensions: {
            errorClass: "VALIDATION",
            legacyCode: "99999",
            inputPath: ["input", "transaction", "amount"],
          },
        },
      ],
      data: { chargePaymentMethod: null },
    });
    const unknownValidation = await bt.charge({
      amountMinor: 1000n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "k6",
    });
    ok(
      "an unrecognised VALIDATION error (nothing created) is a retriable failure that keeps the code",
      unknownValidation.status === "failed" &&
        unknownValidation.failure?.code === "gateway_error" &&
        unknownValidation.failure.retriable === true &&
        unknownValidation.failure.providerCode === "99999",
    );
    // A refusal whose answer names a processor code but carries no transaction: the
    // transaction is found by our orderId, so the refusal keeps its id.
    answer = (op) =>
      op === "search"
        ? {
            data: {
              search: {
                transactions: {
                  edges: [
                    {
                      node: {
                        ...tx("PROCESSOR_DECLINED", "bt2081tx"),
                        createdAt: new Date().toISOString(),
                      },
                    },
                  ],
                },
              },
            },
          }
        : {
            errors: [
              {
                message: "PayPal pending payments are not supported.",
                extensions: { errorClass: "VALIDATION", legacyCode: "2081" },
              },
            ],
            data: { chargePaymentMethod: null },
          };
    const pendingPaypal = await bt.charge({
      amountMinor: 1000n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "k2081",
    });
    ok(
      "a 2081 refusal keeps the gateway transaction id and is not retriable",
      pendingPaypal.status === "failed" &&
        pendingPaypal.providerChargeId === "bt2081tx" &&
        pendingPaypal.failure?.code === "gateway_request_rejected" &&
        pendingPaypal.failure.retriable === false,
    );
    const declined2081 = chargeResultFromTransaction({
      ...tx("PROCESSOR_DECLINED", "bt2081b"),
      statusHistory: [
        {
          __typename: "ProcessorDeclinedEvent",
          status: "PROCESSOR_DECLINED",
          declineType: "HARD",
          processorResponse: {
            legacyCode: "2081",
            message: "PayPal pending payments are not supported",
          },
        },
      ],
    });
    ok(
      "a declined transaction keeps its id, and 2081 reads as our setup",
      declined2081.providerChargeId === "bt2081b" &&
        declined2081.failure?.code === "gateway_request_rejected" &&
        declined2081.failure.retriable === false,
    );
    answer = (op) =>
      op === "search"
        ? { data: { search: { transactions: { edges: [] } } } }
        : {
            errors: [
              {
                message: "Do Not Honor",
                extensions: { errorClass: "VALIDATION", legacyCode: "2000" },
              },
            ],
            data: { chargePaymentMethod: null },
          };
    const notFound = await bt.charge({
      amountMinor: 1000n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "k2000",
    });
    ok(
      "a refusal whose transaction cannot be found still fails, with no id",
      notFound.status === "failed" && notFound.providerChargeId === "",
    );
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    ok(
      "a lost connection on a charge is indeterminate",
      (await throws(() =>
        bt.charge({
          amountMinor: 1000n,
          currency: "USD",
          customer,
          paymentMethod: pm,
          idempotencyKey: "k7",
        }),
      )) instanceof ProviderIndeterminateError,
    );
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const op = /(?:mutation|query)[^{]*\{\s*(\w+)/.exec(body.query)?.[1] ?? "?";
      calls.push({ op, vars: body.variables ?? {} });
      return new Response(JSON.stringify(answer(op, body.variables ?? {})), { status: 200 });
    }) as typeof fetch;

    // Refunds.
    answer = () => ({
      data: {
        reverseTransaction: {
          reversal: { __typename: "Transaction", id: "x", legacyId: "t2", status: "VOIDED" },
        },
      },
    });
    const full = await bt.refund({ providerChargeId: "t2", idempotencyKey: "re1" });
    ok(
      "a full refund before settlement is a void",
      full.status === "succeeded" && full.providerRefundId === "t2",
    );
    answer = () => ({
      errors: [
        {
          message: "Cannot refund or reverse unless the transaction status is SETTLING or SETTLED.",
          extensions: {
            errorClass: "VALIDATION",
            legacyCode: "91506",
            inputPath: ["input", "transactionId"],
          },
        },
      ],
      data: { refundTransaction: null },
    });
    const early = await throws(() =>
      bt.refund({
        providerChargeId: "t2",
        amountMinor: 500n,
        currency: "USD",
        idempotencyKey: "re2",
      }),
    );
    ok(
      "a partial refund before settlement is refused with the remedy",
      early instanceof ProviderRefusalError && /settles/.test((early as Error).message),
    );
    // The engine always sends an amount: the whole of an unsettled sale must still void.
    calls.length = 0;
    answer = (op) =>
      op === "refundTransaction"
        ? {
            errors: [
              {
                message:
                  "Cannot refund or reverse unless the transaction status is SETTLING or SETTLED.",
                extensions: {
                  errorClass: "VALIDATION",
                  legacyCode: "91506",
                  inputPath: ["input", "transactionId"],
                },
              },
            ],
            data: { refundTransaction: null },
          }
        : op === "node"
          ? {
              data: {
                node: {
                  id: "x",
                  legacyId: "t2",
                  status: "SUBMITTED_FOR_SETTLEMENT",
                  amount: { value: "15.00", currencyCode: "USD" },
                },
              },
            }
          : {
              data: {
                reverseTransaction: {
                  reversal: {
                    __typename: "Transaction",
                    id: "x",
                    legacyId: "t2",
                    status: "VOIDED",
                  },
                },
              },
            };
    const whole = await bt.refund({
      providerChargeId: "t2",
      amountMinor: 1500n,
      currency: "USD",
      idempotencyKey: "re4",
    });
    const rev = calls.find((c) => c.op === "reverseTransaction");
    const refKey = (calls.find((c) => c.op === "refundTransaction")?.vars as any)?.input
      ?.apiRequestKey;
    ok(
      "the whole amount of an unsettled sale, sent as an amount, voids it",
      whole.status === "succeeded" &&
        whole.providerRefundId === "t2" &&
        !!rev &&
        (rev.vars as any).input.apiRequestKey !== refKey,
      calls.map((c) => c.op).join(","),
    );
    calls.length = 0;
    const notWhole = await throws(() =>
      bt.refund({
        providerChargeId: "t2",
        amountMinor: 1499n,
        currency: "USD",
        idempotencyKey: "re5",
      }),
    );
    ok(
      "…less than the whole is still refused, and nothing is voided",
      notWhole instanceof ProviderRefusalError && !calls.some((c) => c.op === "reverseTransaction"),
    );
    answer = () => ({
      data: {
        refundTransaction: {
          refund: { id: "x", legacyId: "rf9", status: "SUBMITTED_FOR_SETTLEMENT" },
        },
      },
    });
    const part = await bt.refund({
      providerChargeId: "t2",
      amountMinor: 500n,
      currency: "USD",
      idempotencyKey: "re3",
      ownershipRef: "re_X",
    });
    ok(
      "a partial refund after settlement succeeds with the refund's id",
      part.status === "succeeded" && part.providerRefundId === "rf9",
    );

    // ── Error classes on money mutations (Braintree answers 200 with errors[]). ──
    const gqlErr = (field: string, errorClass: string, legacyCode?: string, message = "x") => ({
      data: { [field]: null },
      errors: [{ message, extensions: { errorClass, ...(legacyCode ? { legacyCode } : {}) } }],
    });
    const charge = (idempotencyKey: string) =>
      bt.charge({
        amountMinor: 1000n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey,
      });
    for (const cls of ["INTERNAL", "SERVICE_AVAILABILITY"]) {
      calls.length = 0;
      answer = () => gqlErr("chargePaymentMethod", cls);
      const e = await throws(() => charge(`k_${cls}`));
      const keys = new Set(calls.map((c) => (c.vars as any).input?.apiRequestKey));
      ok(
        `${cls} on a charge is indeterminate, after replays with the same key`,
        e instanceof ProviderIndeterminateError && calls.length === 3 && keys.size === 1,
        `${String(e)} calls ${calls.length}`,
      );
    }
    answer = () => gqlErr("chargePaymentMethod", "RESOURCE_LIMIT");
    const limited = await charge("k_rl");
    ok(
      "RESOURCE_LIMIT (nothing created) is a definite, retriable failure",
      limited.status === "failed" &&
        limited.failure?.retriable === true &&
        limited.providerChargeId === "",
    );
    let first = true;
    answer = () => {
      if (first) return ((first = false), gqlErr("chargePaymentMethod", "INTERNAL"));
      return {
        data: { chargePaymentMethod: { transaction: tx("SUBMITTED_FOR_SETTLEMENT", "t77") } },
      };
    };
    const replayed = await charge("k_rp");
    ok(
      "a lost answer replayed with the same key adopts the original sale",
      replayed.status === "succeeded" && replayed.providerChargeId === "t77",
    );
    answer = () => ({ data: null, errors: [{ message: "?", extensions: {} }] });
    ok(
      "an error of no known class on a charge is indeterminate, never a plain error",
      (await throws(() => charge("k_un"))) instanceof ProviderIndeterminateError,
    );

    // ── Refund refusals release the reservation. ──
    const saleWithRefunds = {
      data: {
        node: {
          legacyId: "t2",
          amount: { value: "100.00", currencyCode: "USD" },
          refunds: [
            {
              legacyId: "rf1",
              status: "SETTLED",
              orderId: null,
              amount: { value: "60.00", currencyCode: "USD" },
            },
            {
              legacyId: "rf2",
              status: "VOIDED",
              orderId: null,
              amount: { value: "10.00", currencyCode: "USD" },
            },
          ],
        },
      },
    };
    answer = (op) =>
      op === "refundTransaction"
        ? gqlErr("refundTransaction", "VALIDATION", "91521", "Refund amount is too large.")
        : saleWithRefunds;
    const tooLarge = await throws(() =>
      bt.refund({
        providerChargeId: "t2",
        amountMinor: 5000n,
        currency: "USD",
        idempotencyKey: "re6",
      }),
    );
    ok(
      "a refund refused as too large is a refusal that says what is left",
      tooLarge instanceof ProviderRefusalError &&
        /60\.00 USD already refunded.*40\.00 USD is left/.test(tooLarge.message),
      String(tooLarge),
    );
    answer = () =>
      gqlErr("reverseTransaction", "VALIDATION", "91504", "Transaction can only be voided if …");
    ok(
      "a reverse Braintree refuses (91504) is a refusal",
      (await throws(() => bt.refund({ providerChargeId: "t2", idempotencyKey: "re7" }))) instanceof
        ProviderRefusalError,
    );
    answer = () => ({ data: { node: { id: "x", status: "VOIDED" } } });
    ok(
      "a VOIDED Refund reads failed (the customer gets nothing)",
      (await bt.fetchRefundStatus({ providerRefundId: "rf9" })).status === "failed",
    );

    // ── Cards only. ──
    calls.length = 0;
    answer = (op) =>
      op === "vaultPaymentMethod"
        ? {
            data: {
              vaultPaymentMethod: {
                paymentMethod: { id: "pm_bank", details: { __typename: "UsBankAccountDetails" } },
                verification: null,
              },
            },
          }
        : { data: { deletePaymentMethodFromVault: { clientMutationId: null } } };
    const bank = await throws(() =>
      bt.vaultPaymentMethod({ customer, token: "fake-valid-us-bank-account-nonce" } as never),
    );
    ok(
      "a nonce that is not a card is refused and taken off the vault",
      bank instanceof ProviderRefusalError &&
        calls.some((c) => c.op === "deletePaymentMethodFromVault"),
      String(bank),
    );

    // ── locateCharge: a read by our orderId. ──
    calls.length = 0;
    answer = () => ({
      data: {
        search: {
          transactions: {
            edges: [
              { node: tx("GATEWAY_REJECTED", "t5") },
              { node: tx("SUBMITTED_FOR_SETTLEMENT", "t6") },
            ],
          },
        },
      },
    });
    const after = new Date("2026-10-01T00:00:00Z");
    const locate = () =>
      bt.locateCharge({
        ownershipRef: "inv_1",
        idempotencyKey: "k",
        amountMinor: 1000n,
        currency: "USD",
        createdAfter: after,
      });
    const found = await locate();
    const sv = (calls[0]?.vars as any)?.input;
    ok(
      "locateCharge searches our orderId from createdAfter, creates nothing, prefers the captured sale",
      found?.status === "succeeded" &&
        found.providerChargeId === "t6" &&
        sv?.orderId?.is === "tmbilling_ref:inv_1" &&
        sv?.createdAt?.greaterThanOrEqualTo === after.toISOString() &&
        calls.every((c) => c.op === "search"),
    );
    answer = () => ({ data: { search: { transactions: { edges: [] } } } });
    ok("…and answers null when Braintree has none", (await locate()) === null);

    // ── A refund webhook books every refund on the sale. ──
    answer = () => ({
      data: {
        node: {
          legacyId: "txn0001",
          amount: { value: "100.00", currencyCode: "USD" },
          refunds: [
            {
              legacyId: "rf0004",
              status: "SETTLED",
              orderId: "tmbilling_ref:re_X",
              amount: { value: "30.00", currencyCode: "USD" },
            },
            {
              legacyId: "rfcp01",
              status: "SUBMITTED_FOR_SETTLEMENT",
              orderId: null,
              amount: { value: "20.00", currencyCode: "USD" },
            },
          ],
        },
      },
    });
    const enriched = await bt.normalizeWebhook({
      payload: delivery(
        notification(
          "transaction_settled",
          "<transaction><id>rf0004</id><status>settled</status><type>credit</type>" +
            "<currency-iso-code>USD</currency-iso-code><amount>30.00</amount>" +
            "<order-id>tmbilling_ref:re_X</order-id><refunded-transaction-id>txn0001</refunded-transaction-id></transaction>",
        ),
      ),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const recs = enriched[0]?.refunds ?? [];
    ok(
      "a refund's webhook also names the sale's other refunds (one made in the Control Panel)",
      enriched[0]?.type === "charge.refunded" &&
        recs.length === 2 &&
        recs.some(
          (r) => r.providerRefundId === "rfcp01" && r.amountMinor === 2000n && !r.ownershipRef,
        ),
      JSON.stringify(recs, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    );

    // ── The settlement poll: refunds and settlement declines no webhook announces. ──
    const ourSale = { legacyId: "sale01", orderId: "tmbilling_ref:inv_P" };
    const refundNode = (
      legacyId: string,
      status: string,
      sale: { legacyId: string; orderId: string | null } | null,
      orderId: string | null = null,
      value = "25.00",
    ) => ({
      legacyId,
      status,
      orderId,
      createdAt: "2026-10-26T03:00:00Z",
      amount: { value, currencyCode: "USD" },
      refundedTransaction: sale,
    });
    answer = (_op, vars) => {
      const input = vars.input as {
        status?: { is?: string; in?: string[] };
        orderId?: { startsWith?: string };
      };
      if (input.status?.is === "SETTLEMENT_DECLINED")
        return {
          data: {
            search: {
              transactions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      ...tx("SETTLEMENT_DECLINED", "sale02"),
                      orderId: "tmbilling_ref:inv_Q",
                      processorSettlementResponse: {
                        legacyCode: "4001",
                        message: "Settlement Declined",
                      },
                    },
                  },
                  { node: { ...tx("SETTLEMENT_DECLINED", "sale03"), orderId: "other-order" } },
                ],
              },
            },
          },
        };
      if (input.status?.in)
        return {
          data: {
            search: {
              refunds: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [{ node: refundNode("rf_void", "VOIDED", ourSale, "tmbilling_ref:re_V") }],
              },
            },
          },
        };
      return vars.after === "c1"
        ? {
            data: {
              search: {
                refunds: {
                  pageInfo: { hasNextPage: false, endCursor: "c2" },
                  edges: [
                    {
                      node: refundNode(
                        "rf_ours",
                        "SUBMITTED_FOR_SETTLEMENT",
                        ourSale,
                        "tmbilling_ref:re_Y",
                        "10.00",
                      ),
                    },
                  ],
                },
              },
            },
          }
        : {
            data: {
              search: {
                refunds: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  edges: [
                    { node: refundNode("rf_cp", "SUBMITTED_FOR_SETTLEMENT", ourSale) },
                    {
                      node: refundNode("rf_foreign", "SETTLED", {
                        legacyId: "sale09",
                        orderId: "other-order",
                      }),
                    },
                    { node: refundNode("rf_elsewhere", "SETTLED", null) },
                  ],
                },
              },
            },
          };
    };
    calls.length = 0;
    const since = new Date("2026-10-26T00:00:00Z");
    const until = new Date("2026-10-26T01:15:00Z");
    const polled = await bt.pollSettlements({ since, until });
    const inputs = calls.map((x) => x.vars.input as any);
    ok(
      "settlement poll: refunds created in the window, paged by endCursor",
      calls.length === 4 &&
        calls.every((x) => x.op === "search") &&
        inputs[0]?.createdAt?.greaterThanOrEqualTo === since.toISOString() &&
        inputs[0]?.createdAt?.lessThanOrEqualTo === until.toISOString() &&
        calls[1]?.vars.after === "c1",
      JSON.stringify(calls.map((x) => x.vars)),
    );
    ok(
      "settlement poll: failed refunds and our declined sales are searched 7 days back by status",
      inputs[2]?.status?.in?.includes("VOIDED") &&
        inputs[2]?.createdAt?.greaterThanOrEqualTo === "2026-10-19T00:00:00.000Z" &&
        inputs[3]?.status?.is === "SETTLEMENT_DECLINED" &&
        inputs[3]?.orderId?.startsWith === "tmbilling_ref:",
    );
    const byId = (id: string) => polled.find((e) => e.providerEventId === id);
    const cp = byId("bt_poll_refund_rf_cp_SUBMITTED_FOR_SETTLEMENT");
    ok(
      "settlement poll: a Control Panel refund on our sale is charge.refunded at its own amount",
      cp?.type === "charge.refunded" &&
        cp.providerChargeId === "sale01" &&
        cp.refunds?.length === 1 &&
        cp.refunds[0]!.providerRefundId === "rf_cp" &&
        cp.refunds[0]!.amountMinor === 2500n &&
        cp.refunds[0]!.status === "succeeded" &&
        !cp.refunds[0]!.ownershipRef,
    );
    ok(
      "settlement poll: our own refund carries its ownership ref (booked once by id)",
      byId("bt_poll_refund_rf_ours_SUBMITTED_FOR_SETTLEMENT")?.refunds?.[0]?.ownershipRef ===
        "re_Y",
    );
    ok(
      "settlement poll: a voided refund is a failed record",
      byId("bt_poll_refund_rf_void_VOIDED")?.refunds?.[0]?.status === "failed",
    );
    const declined = byId("bt_poll_sale_sale02_SETTLEMENT_DECLINED");
    ok(
      "settlement poll: our sale declined at settlement is a late reversal",
      declined?.type === "charge.failed" &&
        declined.lateReversal === true &&
        declined.providerChargeId === "sale02" &&
        declined.providerFailureCode === "4001",
      JSON.stringify(declined, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    );
    ok(
      "settlement poll: refunds of other sales and sales not ours are skipped",
      polled.length === 4 &&
        !polled.some((e) => /rf_foreign|rf_elsewhere|sale03/.test(e.providerEventId)),
      polled.map((e) => e.providerEventId).join(),
    );
    calls.length = 0;
    answer = () => ({
      data: {
        search: {
          refunds: { pageInfo: { hasNextPage: true, endCursor: "next" }, edges: [] },
        },
      },
    });
    const endless = await throws(() => bt.pollSettlements({ since, until }));
    ok(
      "settlement poll: a search past 40 pages throws (the window is read again)",
      endless instanceof Error && calls.length === 40,
      String(endless),
    );

    // ── 7. PayPal, Venmo and 3D Secure at the nonce. ──
    const nonceRead = (details: Record<string, unknown> | null) => ({
      data: { node: details ? { details } : null },
    });
    const card3ds = (shifted: boolean, possible: boolean, status: string) => ({
      __typename: "CreditCardDetails",
      threeDSecure: {
        authentication: {
          liabilityShifted: shifted,
          liabilityShiftPossible: possible,
          authenticationStatus: status,
        },
      },
    });
    const vaultedAs = (typename: string, id: string, extra: Record<string, unknown> = {}) => ({
      data: {
        vaultPaymentMethod: {
          paymentMethod: { id, legacyId: id, details: { __typename: typename, ...extra } },
          verification: null,
        },
      },
    });
    answer = (op) =>
      op === "createClientToken"
        ? { data: { createClientToken: { clientToken: "ctok" } } }
        : { data: null };
    const wallets = await bt.createIntent({
      purpose: "setup",
      currency: "USD",
      customer,
      idempotencyKey: "pi_w_1",
      ownershipRef: "pi_w",
      methodTypes: ["paypal", "card", "upi", "venmo"],
      contact: { email: "payer@example.com", country: "US" },
    });
    const wp = wallets.authorization?.sdk?.params as Record<string, unknown>;
    ok(
      "a setup intent offers the requested methods we support, with the payer's email and country",
      JSON.stringify(wp.methods) === JSON.stringify(["paypal", "card", "venmo"]) &&
        wp.email === "payer@example.com" &&
        wp.billingCountry === "US",
      JSON.stringify(wp),
    );
    ok(
      "a setup intent carries a zero amount for the 3D Secure check of a saved card",
      wp.amount === "0.00" && wp.currency === "USD",
    );
    ok(
      "the offered methods ride the intent id",
      decodeSyntheticIntent(wallets.intentId)?.t?.join() === "paypal,card,venmo",
    );
    const cardOnly = await bt.createIntent({
      purpose: "setup",
      currency: "USD",
      customer,
      idempotencyKey: "pi_c_1",
      ownershipRef: "pi_c",
    });
    ok(
      "with no method requested, Drop-in shows cards only",
      JSON.stringify(cardOnly.authorization?.sdk?.params.methods) === '["card"]',
    );

    calls.length = 0;
    answer = (op) =>
      op === "node"
        ? nonceRead({ __typename: "PayPalAccountDetails" })
        : vaultedAs("PayPalAccountDetails", "cGF5bWVudG1ldGhvZF9wcF9hYmM", {
            email: "payer@example.com",
          });
    const pp = await bt.submitClientResult!({
      intentId: wallets.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-paypal-billing-agreement-nonce" },
      idempotencyKey: "kw1",
    });
    ok(
      "a PayPal account is read, then vaulted when the intent offered PayPal",
      pp.status === "authorized" &&
        pp.gatewayIntentId === "cGF5bWVudG1ldGhvZF9wcF9hYmM" &&
        calls.map((c) => c.op).join() === "node,vaultPaymentMethod",
      calls.map((c) => c.op).join(),
    );
    answer = (op) =>
      op === "node"
        ? nonceRead({ __typename: "VenmoAccountDetails" })
        : vaultedAs("VenmoAccountDetails", "cGF5bWVudG1ldGhvZF92ZW5tb19hYmM", { username: "x" });
    const vm = await bt.submitClientResult!({
      intentId: wallets.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-venmo-account-nonce" },
      idempotencyKey: "kw2",
    });
    ok("a Venmo account is vaulted when the intent offered Venmo", vm.status === "authorized");
    calls.length = 0;
    answer = (op) => (op === "node" ? nonceRead({ __typename: "PayPalAccountDetails" }) : {});
    const ppOnCard = await bt.submitClientResult!({
      intentId: cardOnly.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-paypal-billing-agreement-nonce" },
      idempotencyKey: "kw3",
    });
    ok(
      "a PayPal nonce on a cards-only intent is refused before anything is vaulted",
      ppOnCard.status === "failed" &&
        ppOnCard.failure?.code === "payment_method_not_supported" &&
        !calls.some((c) => c.op === "vaultPaymentMethod"),
    );
    answer = () =>
      vaultedAs("PayPalAccountDetails", "cGF5bWVudG1ldGhvZF9wcF9kZWY") as Record<string, unknown>;
    const viaVault = await bt.vaultPaymentMethod({
      customer,
      token: "fake-paypal-billing-agreement-nonce",
    } as never);
    ok(
      "a PayPal account saved outside an intent is described as PayPal",
      viaVault.display.type === "paypal",
    );

    // 3D Secure: refuse what Braintree rejects when 3D Secure is required.
    const tds = async (auth: ReturnType<typeof card3ds>, label: string) => {
      calls.length = 0;
      answer = (op) =>
        op === "node"
          ? nonceRead(auth)
          : {
              data: {
                vaultPaymentMethod: {
                  paymentMethod: {
                    id: "cGF5bWVudG1ldGhvZF9jY190ZHM",
                    legacyId: "tds",
                    details: { __typename: "CreditCardDetails", last4: "0002" },
                  },
                  verification: { status: "VERIFIED" },
                },
              },
            };
      return bt.submitClientResult!({
        intentId: wallets.intentId,
        purpose: "setup",
        clientResult: { nonce: `fake-3ds-${label}` },
        idempotencyKey: `kt-${label}`,
      });
    };
    for (const [status, possible] of [
      ["AUTHENTICATE_FAILED", true],
      ["AUTHENTICATE_REJECTED", false],
      ["AUTHENTICATE_FRICTIONLESS_FAILED", false],
      ["CHALLENGE_REQUIRED", true],
    ] as const) {
      const r = await tds(card3ds(false, possible, status), status);
      ok(
        `3D Secure ${status}: the card is refused before it is saved`,
        r.status === "failed" &&
          r.failure?.code === "authentication_required" &&
          !calls.some((c) => c.op === "vaultPaymentMethod"),
        JSON.stringify(r.failure),
      );
    }
    for (const [status, shifted, possible] of [
      ["AUTHENTICATE_SUCCESSFUL", true, true],
      ["AUTHENTICATE_ATTEMPT_SUCCESSFUL", true, true],
      ["LOOKUP_NOT_ENROLLED", false, false],
      ["AUTHENTICATION_UNAVAILABLE", false, false],
      ["LOOKUP_BYPASSED", false, false],
    ] as const) {
      const r = await tds(card3ds(shifted, possible, status), status);
      ok(`3D Secure ${status}: the card is saved`, r.status === "authorized", JSON.stringify(r));
    }
    calls.length = 0;
    globalThis.fetch = (async () => new Response("upstream", { status: 503 })) as typeof fetch;
    const unread = await bt.submitClientResult!({
      intentId: wallets.intentId,
      purpose: "setup",
      clientResult: { nonce: "fake-valid-nonce" },
      idempotencyKey: "kt-unread",
    });
    ok(
      "a nonce we could not read fails the attempt (nothing moved), retriable by the buyer",
      unread.status === "failed" && unread.failure?.code === "processing_error",
      JSON.stringify(unread),
    );
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const op = /(?:mutation|query)[^{]*\{\s*(\w+)/.exec(body.query)?.[1] ?? "?";
      calls.push({ op, vars: body.variables ?? {} });
      return new Response(JSON.stringify(answer(op, body.variables ?? {})), { status: 200 });
    }) as typeof fetch;

    answer = (op) =>
      op === "createClientToken"
        ? { data: { createClientToken: { clientToken: "ctok" } } }
        : { data: null };
    const payWallet = await bt.createIntent({
      purpose: "payment",
      amountMinor: 1999n,
      currency: "USD",
      customer,
      idempotencyKey: "pi_pw_1",
      ownershipRef: "inv_PW",
      methodTypes: ["card", "paypal"],
    });
    calls.length = 0;
    answer = (op) => (op === "node" ? nonceRead(card3ds(false, true, "AUTHENTICATE_FAILED")) : {});
    const payRefused = await bt.submitClientResult!({
      intentId: payWallet.intentId,
      purpose: "payment",
      clientResult: { nonce: "fake-three-d-secure-visa-failed-authentication-nonce" },
      idempotencyKey: "kp1",
    });
    ok(
      "a payment whose 3D Secure failed is refused before any authorization (no hold)",
      payRefused.status === "failed" &&
        payRefused.failure?.code === "authentication_required" &&
        !calls.some((c) => c.op === "authorizePaymentMethod"),
    );
    answer = (op) =>
      op === "node"
        ? nonceRead({ __typename: "PayPalAccountDetails" })
        : {
            data: {
              authorizePaymentMethod: {
                transaction: {
                  ...tx("AUTHORIZED", "tpp1"),
                  paymentMethodSnapshot: { __typename: "PayPalTransactionDetails" },
                },
              },
            },
          };
    const payPal = await bt.submitClientResult!({
      intentId: payWallet.intentId,
      purpose: "payment",
      clientResult: { nonce: "fake-paypal-one-time-nonce" },
      idempotencyKey: "kp2",
    });
    ok(
      "a PayPal payment authorizes when the intent offered PayPal",
      payPal.status === "authorized",
    );
    ok(
      "a PayPal sale reports paypal as the method used",
      chargeResultFromTransaction({
        ...tx("SETTLING", "tpp2"),
        paymentMethodSnapshot: { __typename: "PayPalTransactionDetails" },
      }).methodUsed === "paypal" &&
        chargeResultFromTransaction({
          ...tx("SETTLING", "tvm2"),
          paymentMethodSnapshot: { __typename: "VenmoAccountDetails" },
        }).methodUsed === "venmo",
    );
    ok(
      "a PayPal sale in SETTLING (captured at submission) is collected",
      chargeResultFromTransaction({
        ...tx("SETTLING", "tpp3"),
        paymentMethodSnapshot: { __typename: "PayPalTransactionDetails" },
      }).status === "succeeded",
    );

    // PayPal refunds: refundable while SETTLING, never voidable there.
    calls.length = 0;
    answer = () => ({
      data: { refundTransaction: { refund: { id: "r", legacyId: "rpp1", status: "SETTLING" } } },
    });
    const ppPartial = await bt.refund({
      providerChargeId: "tpp3",
      amountMinor: 500n,
      currency: "USD",
      idempotencyKey: "rpp1",
    });
    ok(
      "a partial refund of a settling PayPal sale is a refund (no void attempt)",
      ppPartial.status === "succeeded" && calls.map((c) => c.op).join() === "refundTransaction",
    );
    answer = () => ({
      data: {
        reverseTransaction: {
          reversal: { __typename: "Refund", id: "r", legacyId: "rpp2", status: "SETTLING" },
        },
      },
    });
    const ppFull = await bt.refund({ providerChargeId: "tpp3", idempotencyKey: "rpp2" });
    ok(
      "a full refund of a settling PayPal sale is a Refund record, not a void",
      ppFull.status === "succeeded" && ppFull.providerRefundId === "rpp2",
    );

    // ── 8. Revoked methods and the account updater. ──
    const revoked = (subject: string) =>
      bt.normalizeWebhook({
        payload: delivery(notification("payment_method_revoked_by_customer", subject)),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    calls.length = 0;
    const withGlobal = await revoked(
      "<paypal-account><token>pptok1</token><global-id>cGF5bWVudG1ldGhvZF9wcF9wcHRvazE</global-id>" +
        '<revoked-at type="datetime">2026-10-28T10:00:00Z</revoked-at></paypal-account>',
    );
    ok(
      "a revoked PayPal billing agreement detaches the method by its global id",
      withGlobal[0]?.type === "payment_method.detached" &&
        withGlobal[0].providerPaymentMethodId === "cGF5bWVudG1ldGhvZF9wcF9wcHRvazE" &&
        calls.length === 0,
    );
    answer = (op) =>
      op === "idsFromLegacyIds"
        ? { data: { idsFromLegacyIds: ["cGF5bWVudG1ldGhvZF92ZW5tb192bXRvazE"] } }
        : { data: null };
    const viaToken = await revoked(
      "<venmo-account><token>vmtok1</token><username>venmojoe</username></venmo-account>",
    );
    ok(
      "a revoked Venmo account with no global id is resolved from its token",
      viaToken[0]?.type === "payment_method.detached" &&
        viaToken[0].providerPaymentMethodId === "cGF5bWVudG1ldGhvZF92ZW5tb192bXRvazE",
    );
    answer = () => ({ data: { idsFromLegacyIds: [null] } });
    const unresolved = await revoked("<venmo-account><token>vmgone</token></venmo-account>");
    ok(
      "a revoked token Braintree cannot resolve is recorded only",
      unresolved[0]?.type === "unknown",
    );
    const dataUpdated = await bt.normalizeWebhook({
      payload: delivery(
        notification(
          "payment_method_customer_data_updated",
          "<venmo-account><token>v</token></venmo-account>",
        ),
      ),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    ok("customer data updated (Venmo profile) is not acted on", dataUpdated[0]?.type === "unknown");

    ok(
      "the report's changed cards are the new number and new expiry rows only",
      changedCardTokens(
        'payment_method_token,update_type,last_4\r\naa1,New expiry date,1111\r\n"bb2","New account number","2222"\r\ncc3,Match found - card is current,3333\r\ndd4,Call customer - account closed,4444\r\n',
      ).join() === "aa1,bb2",
    );
    ok(
      "a report with no token column is refused, not read as empty",
      (await throws(() =>
        changedCardTokens("update_type,last_4\nNew expiry date,1111\n"),
      )) instanceof Error,
    );
    const report = (url: string) =>
      bt.normalizeWebhook({
        payload: delivery(
          notification(
            "account_updater_daily_report",
            `<account-updater-daily-report><report-date type="date">2026-10-27</report-date><report-url>${url}</report-url></account-updater-daily-report>`,
          ),
        ),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    const graphql = globalThis.fetch;
    let csvStatus = 200;
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      if (String(u).startsWith("https://reports.example.com/"))
        return new Response(
          "payment_method_token,update_type\nau1,New expiry date\nau2,Call customer for updates\nau3,New account number\n",
          { status: csvStatus },
        );
      return graphql(u as string, init);
    }) as typeof fetch;
    answer = (op, vars) => {
      if (op === "idsFromLegacyIds")
        return { data: { idsFromLegacyIds: ["cGF5bWVudG1ldGhvZF9jY19hdTE", null] } };
      if (op === "node" && vars.id === "cGF5bWVudG1ldGhvZF9jY19hdTE")
        return {
          data: {
            node: {
              id: "cGF5bWVudG1ldGhvZF9jY19hdTE",
              details: {
                __typename: "CreditCardDetails",
                brandCode: "VISA",
                last4: "4242",
                expirationMonth: "09",
                expirationYear: "2031",
              },
            },
          },
        };
      return { data: null };
    };
    const au = await report("https://reports.example.com/au.csv");
    ok(
      "the daily report updates each changed card from Braintree's own record, token unchanged",
      au.length === 1 &&
        au[0]!.type === "payment_method.updated" &&
        au[0]!.providerPaymentMethodId === "cGF5bWVudG1ldGhvZF9jY19hdTE" &&
        au[0]!.card?.expMonth === 9 &&
        au[0]!.card?.expYear === 2031 &&
        au[0]!.card?.last4 === "4242",
      JSON.stringify(au.map((e) => [e.type, e.providerPaymentMethodId, e.card])),
    );
    ok(
      "each updated card has its own event id",
      au.every((e) => e.providerEventId.endsWith("_au1")),
    );
    csvStatus = 410;
    ok(
      "a report that cannot be fetched throws, so Braintree delivers it again",
      (await throws(() => report("https://reports.example.com/au.csv"))) instanceof Error,
    );
    globalThis.fetch = graphql;

    ok(
      "the 3D Secure rule and the merchant-account rules are in the Braintree table",
      normalizeBraintreeDecline({ category: "THREE_D_SECURE_NOT_SHIFTED", code: "X" }).code ===
        "authentication_required" &&
        normalizeBraintreeDecline("91577").code === "gateway_request_rejected" &&
        normalizeBraintreeDecline("91517").code === "gateway_request_rejected",
    );
    ok(
      "the 3D Secure policy reads Braintree's reject table and liability",
      braintreeThreeDSecureFailure(null) === null &&
        braintreeThreeDSecureFailure({
          liabilityShifted: false,
          liabilityShiftPossible: false,
          authenticationStatus: "EXEMPTION_LOW_VALUE_SUCCESSFUL",
        }) === null &&
        braintreeThreeDSecureFailure({
          liabilityShifted: false,
          liabilityShiftPossible: false,
          authenticationStatus: "LOOKUP_SERVER_ERROR",
        })?.code === "authentication_required",
    );
    ok(
      "offered methods: only card, paypal and venmo, else cards",
      braintreeOfferedMethods(["upi"]).join() === "card" &&
        braintreeOfferedMethods(["venmo", "venmo", "card"]).join() === "venmo,card",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ BRAINTREE: PASS" : "❌ BRAINTREE: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
