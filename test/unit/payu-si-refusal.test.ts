/**
 * A `status: 0` si_transaction refusal made no transaction: it is booked at once, never left
 * pending. A synchronous `failed` keeps the E-code from the transaction row.
 */
import { describe, it, expect } from "vitest";
import { PayuProvider } from "@/providers/payu";
import { ProviderIndeterminateError } from "@/providers/types";

type Answer = Record<string, unknown>;
let txnid = "";

function provider(
  siAnswer: (txnid: string) => Answer,
  lookup: (n: number, txnid: string) => Answer | Error,
) {
  const p = new PayuProvider({ merchantKey: "unit", merchantSalt: "unit", livemode: false });
  const calls: string[] = [];
  let lookups = 0;
  (p as unknown as { command: unknown }).command = async (
    _op: string,
    command: string,
    var1: string,
  ) => {
    calls.push(command);
    if (command === "si_transaction") return siAnswer(JSON.parse(var1).txnid);
    txnid = var1;
    const a = lookup(lookups++, var1);
    if (a instanceof Error) throw a;
    return a;
  };
  return { p, calls };
}

const notFound = (txnid: string) => ({
  status: 0,
  transaction_details: { [txnid]: { mihpayid: "Not Found", status: "Not Found" } },
});

const INPUT = {
  idempotencyKey: "inv_unit_a1",
  amountMinor: 10_000n,
  currency: "INR",
  customer: { providerKey: "payu" as const, providerCustomerId: "cus_unit" },
  paymentMethod: {
    providerKey: "payu" as const,
    providerPaymentMethodId: "nb:900000000001",
    display: { type: "bank_transfer" },
  },
} as unknown as Parameters<PayuProvider["charge"]>[0];

const capture = (a: Answer) => (t: string) => {
  txnid = t;
  return a;
};

describe("payu charge: a status-0 refusal with no transaction", () => {
  it("books a documented request fault as gateway_request_rejected", async () => {
    const { p, calls } = provider(
      capture({ status: 0, message: "Invalid country. Only 'IN' or 'India' is allowed." }),
      () => notFound(txnid),
    );
    const r = await p.charge(INPUT);
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("gateway_request_rejected");
    expect(r.failure?.ruleId).toBe("payu.message.invalid_country");
    // The rule names it: no second lookup.
    expect(calls).toEqual(["verify_payment", "si_transaction"]);
  });

  it("books an unknown text as a hidden generic failure after one Not Found", async () => {
    const { p, calls } = provider(capture({ status: 0, msg: "Something new" }), () =>
      notFound(txnid),
    );
    const r = await p.charge(INPUT);
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("gateway_error");
    expect(r.failure?.message).toContain("Something new");
    expect(calls).toEqual(["verify_payment", "si_transaction", "verify_payment"]);
  });

  it("keeps a PayU internal fault indeterminate: the debit may still land", async () => {
    const { p, calls } = provider(capture({ status: 0, msg: "Something went wrong" }), () =>
      notFound(txnid),
    );
    await expect(p.charge(INPUT)).rejects.toBeInstanceOf(ProviderIndeterminateError);
    expect(calls).toEqual(["verify_payment", "si_transaction"]);
  });

  it("stays indeterminate when the lookup cannot be read", async () => {
    const { p } = provider(capture({ status: 0, msg: "Something new" }), (n) =>
      n === 0 ? notFound(txnid) : new Error("socket hang up"),
    );
    await expect(p.charge(INPUT)).rejects.toBeInstanceOf(ProviderIndeterminateError);
  });

  it("takes the transaction's outcome when the lookup finds one", async () => {
    const { p } = provider(capture({ status: 0, msg: "Something new" }), (n) =>
      n === 0
        ? notFound(txnid)
        : {
            status: 1,
            transaction_details: { [txnid]: { mihpayid: "1", status: "success" } },
          },
    );
    expect((await p.charge(INPUT)).status).toBe("succeeded");
  });
});

describe("payu charge: a synchronous failed debit", () => {
  it("reads the E-code from the transaction row, not only field9", async () => {
    const { p } = provider(
      (t) => {
        txnid = t;
        return { status: 1, details: { [t]: { status: "failed", field9: "Declined" } } };
      },
      (n) =>
        n === 0
          ? notFound(txnid)
          : {
              status: 1,
              transaction_details: {
                [txnid]: {
                  mihpayid: "1",
                  status: "failure",
                  error_code: "E4316",
                  error_Message: "WITHDRAWAL STOPPED OWING TO DEATH OF ACCOUNT HOLDER",
                },
              },
            },
    );
    const r = await p.charge(INPUT);
    expect(r.failure?.code).toBe("bank_account_closed");
    expect(r.failure?.providerCode).toBe("E4316");
    expect(r.failure?.retriable).toBe(false);
  });

  it("falls back to field9 when the row cannot be read", async () => {
    const { p } = provider(
      (t) => {
        txnid = t;
        return {
          status: 1,
          details: { [t]: { status: "failed", field9: "mandate is not active" } },
        };
      },
      (n) => (n === 0 ? notFound(txnid) : new Error("timeout")),
    );
    const r = await p.charge(INPUT);
    expect(r.status).toBe("failed");
    expect(r.failure?.code).toBe("mandate_expired");
  });
});
