import type { MeasureSource } from "@/modules/metrics/daily/measures";
import type { ReportCategory } from "@/modules/metrics/reports/registry";

/**
 * The shelf a measure or report sits on in Stats and Explore. One place derives it, from
 * the measure's `source`, so a new measure lands in a group with no edit here.
 *
 * `all` and `payments` hold figures every business has. The other four match
 * `BillingModel` (`billing-models.ts`): a business without that model sees them folded.
 */
export type MeasureModelGroup =
  | "all"
  | "subscriptions"
  | "one_time"
  | "usage"
  | "credits"
  | "payments";

export function measureModelGroup(source: MeasureSource): MeasureModelGroup {
  switch (source) {
    case "stocks":
    case "movements":
    case "subscriptions":
    case "scheduled":
    case "customer_grain":
    case "derived":
    case "read_time":
      return "subscriptions";
    case "orders":
      return "one_time";
    case "usage":
      return "usage";
    case "credits":
      return "credits";
    case "transactions":
    case "payments":
    case "payment_methods":
    case "disputes":
      return "payments";
    default:
      // invoices, customers, and any source added later.
      return "all";
  }
}

export function reportModelGroup(category: ReportCategory): MeasureModelGroup {
  if (category === "transactions") return "payments";
  if (category === "receivables") return "all";
  return "subscriptions";
}
