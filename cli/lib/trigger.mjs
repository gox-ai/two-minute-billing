// tmb trigger: create real test objects so real events fire.
import { randomBytes } from "node:crypto";
import {
  CliError,
  call,
  opt,
  positionals,
  requireTestKey,
  settings,
  testBusiness,
} from "./api.mjs";

// Test cards of the built-in test gateway: one is charged, the other declines every charge.
const CARD_OK = "4242424242424242";
const CARD_DECLINE = "4000000000000002";

export const SCENARIOS = {
  purchase: { price: "one_time", card: CARD_OK, expect: "invoice_paid, payment_succeeded" },
  "payment-failed": { price: "one_time", card: CARD_DECLINE, expect: "payment_failed" },
  subscription: { price: "recurring", card: CARD_OK, expect: "subscription_created" },
};

export async function trigger(argv) {
  const [name] = positionals(argv, ["price", "business"]);
  const sc = SCENARIOS[name];
  if (!sc) throw new CliError(`scenario: ${Object.keys(SCENARIOS).join(" | ")}`);
  const s = settings({ needBusiness: true, business: opt(argv, "business") });
  await requireTestKey(s, "tmb trigger");
  await testBusiness(s);
  const base = `/v1/businesses/${s.biz}`;

  let price;
  const wanted = opt(argv, "price");
  if (wanted) {
    price = (await call(s, "GET", `${base}/prices/${encodeURIComponent(wanted)}`)).body;
    if (price.type !== sc.price)
      throw new CliError(`price ${wanted} is ${price.type}; ${name} needs a ${sc.price} price.`);
  } else {
    const { body } = await call(s, "GET", `${base}/prices?status=active&limit=100`);
    price = (body.data ?? []).find((p) => p.type === sc.price && !p.metered);
    if (!price)
      throw new CliError(
        `no active ${sc.price} price in ${s.biz}. Create one (tmb push), or pass --price.`,
      );
    console.log(`Using price ${price.id}${price.name ? ` (${price.name})` : ""}.`);
  }

  const email = `trigger+${randomBytes(4).toString("hex")}@example.com`;
  const customer = (await call(s, "POST", `${base}/customers`, { email, currency: price.currency }))
    .body;
  const pm = (
    await call(s, "POST", `${base}/customers/${customer.id}/payment_methods`, { token: sc.card })
  ).body;
  const created = { customer: `${customer.id} (${email})`, payment_method: pm.id };

  let outcomeOk = true;
  if (sc.price === "one_time") {
    const r = await call(
      s,
      "POST",
      `${base}/invoices`,
      { customer: customer.id, lines: [{ price: price.id }], collect: true },
      { allow: [402] },
    );
    const inv =
      r.body.object === "invoice"
        ? r.body
        : (
            await call(
              s,
              "GET",
              `${base}/invoices?customer=${customer.id}&limit=1&sort_by[desc]=created_at`,
            )
          ).body.data?.[0];
    created.invoice = inv ? `${inv.id} (${inv.status})` : "none";
    outcomeOk = name === "purchase" ? inv?.status === "paid" : !!inv && inv.status !== "paid";
  } else {
    const sub = (
      await call(s, "POST", `${base}/customers/${customer.id}/subscriptions`, {
        items: [{ price: price.id, quantity: 1 }],
      })
    ).body;
    created.subscription = `${sub.id} (${sub.status})`;
  }

  for (const [k, v] of Object.entries(created)) console.log(`${k.padEnd(15)} ${v}`);
  console.log(
    outcomeOk
      ? `Expected events: ${sc.expect}.`
      : `The outcome was not the one ${name} expects (${sc.expect}). Look at the invoice in the dashboard.`,
  );
  return outcomeOk ? 0 : 2;
}
