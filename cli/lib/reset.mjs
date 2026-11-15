// tmb reset: put a test business back to a new test twin of its live business.
import { createInterface } from "node:readline/promises";
import { CliError, call, opt, requireTestKey, settings, testBusiness } from "./api.mjs";

export const RESET_DELETES =
  "the customers and every subscription, invoice, payment and credit note, the catalog, " +
  "coupons, taxes, dunning, webhook endpoints, gateways and email settings. Time Travel stops. " +
  "The business id, team members, API keys and the audit log stay.";

export async function reset(argv) {
  const s = settings({ needBusiness: true, business: opt(argv, "business") });
  await requireTestKey(s, "tmb reset");
  const biz = await testBusiness(s);

  console.log(`Reset test business ${biz.id}${biz.name ? ` (${biz.name})` : ""}.`);
  console.log(`This deletes ${RESET_DELETES}`);
  let typed = opt(argv, "confirm");
  if (typed === undefined) {
    if (!process.stdin.isTTY)
      throw new CliError(`not confirmed. Run again with --confirm ${biz.id}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    typed = (await rl.question(`You cannot undo this. Type the business id to continue: `)).trim();
    rl.close();
  }
  if (typed !== biz.id)
    throw new CliError(`not confirmed: ${JSON.stringify(typed)} is not ${biz.id}.`);

  const { body } = await call(
    s,
    "POST",
    `/v1/businesses/${biz.id}/test_data/reset`,
    {},
    {
      timeout: 5 * 60_000,
    },
  );
  console.log(`Business ${body.business} reset: ${body.deleted} rows deleted.`);
  return 0;
}
