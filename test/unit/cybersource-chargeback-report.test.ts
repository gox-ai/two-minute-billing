import { describe, it, expect } from "vitest";
import {
  CYBERSOURCE_CHARGEBACK_REPORT,
  mapChargebackReportRow,
  parseChargebackReport,
  parseCsv,
} from "../../src/providers/cybersource";
import { GATEWAYS, disputesArriveByReport } from "../../src/providers/gateway-catalog";

const OURS = `tm${"a".repeat(28)}`;
const REQ = "7000000000000000000001";

/** A daily report as a subscription delivers it: a title block, then the header line. */
const REPORT = [
  `Chargeback And Retrieval Detail Report,1.0,2026-11-16,${CYBERSOURCE_CHARGEBACK_REPORT}`,
  "Request.RequestID,Request.MerchantReferenceNumber,ChargebackAndRetrieval.CaseNumber,ChargebackAndRetrieval.ChargebackAmount,ChargebackAndRetrieval.ChargebackCurrency,ChargebackAndRetrieval.ChargebackReasonCode,ChargebackAndRetrieval.ChargebackReasonCodeDescription,ChargebackAndRetrieval.ChargebackTime,ChargebackAndRetrieval.RespondByDate,ChargebackAndRetrieval.FinancialImpact,ChargebackAndRetrieval.FinancialImpactType",
  `${REQ},${OURS},CASE0001,12.34,USD,10.4,"Other Fraud, Card Absent",2026-11-16T09:00:00Z,2026-12-06,Y,Debit`,
  `${REQ},${OURS},CASE0001,12.34,USD,10.4,"Other Fraud, Card Absent",2026-11-20T09:00:00Z,,Y,Credit`,
  `${REQ},${OURS},CASE0002,12.34,USD,,,2026-11-16T10:00:00Z,,N,None`,
  `${REQ},someone-else-ref,CASE0003,5.00,USD,13.1,,2026-11-16T11:00:00Z,,Y,Debit`,
  `,${OURS},CASE0004,5.00,USD,13.1,,2026-11-16T11:00:00Z,,Y,Debit`,
].join("\r\n");

describe("CyberSource chargeback report", () => {
  it("parses quoted CSV fields with commas and doubled quotes", () => {
    expect(parseCsv('a,"b, c","d ""e"""\nf,g,h\n')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["f", "g", "h"],
    ]);
  });

  it("finds the header below the title block and drops field groups", () => {
    const rows = parseChargebackReport(REPORT);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      requestid: REQ,
      casenumber: "CASE0001",
      chargebackamount: "12.34",
      chargebackreasoncodedescription: "Other Fraud, Card Absent",
    });
  });

  it("refuses an XML report: the subscription must be CSV", () => {
    expect(() => parseChargebackReport("<?xml version='1.0'?><Report/>")).toThrow(/CSV/);
  });

  it("gives nothing for a report with no case column", () => {
    expect(parseChargebackReport("a,b\n1,2")).toEqual([]);
  });

  it("maps a debit to created + funds_withdrawn and a credit to funds_reinstated + won", () => {
    const rows = parseChargebackReport(REPORT);
    const debit = mapChargebackReportRow(rows[0]!, "2026-11-16");
    expect(debit.map((e) => e.type)).toEqual(["dispute.created", "dispute.funds_withdrawn"]);
    expect(debit[0]).toMatchObject({
      providerDisputeId: "CASE0001",
      providerChargeId: REQ,
      disputeAmountMinor: 1234n,
      disputeCurrency: "USD",
      disputeReason: "10.4 Other Fraud, Card Absent",
    });
    expect(debit[0]!.evidenceDueBy?.toISOString()).toBe("2026-12-06T00:00:00.000Z");
    const credit = mapChargebackReportRow(rows[1]!, "2026-11-20");
    expect(credit.map((e) => e.type)).toEqual(["dispute.funds_reinstated", "dispute.won"]);
    // Ids are stable across re-reads and distinct per row.
    const again = mapChargebackReportRow(rows[0]!, "2026-11-16");
    expect(again.map((e) => e.providerEventId)).toEqual(debit.map((e) => e.providerEventId));
    expect(new Set([...debit, ...credit].map((e) => e.providerEventId)).size).toBe(4);
  });

  it("skips a retrieval request, another system's payment and a row with no request id", () => {
    const rows = parseChargebackReport(REPORT);
    expect(mapChargebackReportRow(rows[2]!, "2026-11-16")).toEqual([]);
    expect(mapChargebackReportRow(rows[3]!, "2026-11-16")).toEqual([]);
    expect(mapChargebackReportRow(rows[4]!, "2026-11-16")).toEqual([]);
  });

  it("the catalogue says CyberSource disputes arrive by report and never with a loss", () => {
    expect(disputesArriveByReport("cybersource")).toBe(true);
    expect(GATEWAYS.cybersource.disputeFinalState).toBe(false);
    expect(GATEWAYS.cybersource.disputeFeed).toBe(false);
    expect(disputesArriveByReport("authorizenet")).toBe(false);
  });
});
