/** What a tool call did, in plain words for the panel's step list. */
export function stepLabel(name: string, a: Record<string, unknown>): string {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "get_business":
      return "Read the business settings";
    case "search_customers":
      return s("query") ? `Searched customers for "${s("query")}"` : "Listed customers";
    case "get_customer":
      return `Read customer ${s("customer")}`;
    case "list_subscriptions":
      return "Listed subscriptions";
    case "get_upcoming_charges":
      return s("from") || s("to")
        ? `Read the charges from ${s("from") || "today"} to ${s("to") || "30 days later"}`
        : "Read the charges for the next 30 days";
    case "get_catalog":
      return "Read the product catalog";
    case "get_collections_queue":
      return `Read the invoices to retry in the next ${typeof a.days === "number" ? a.days : 7} days`;
    case "get_timeline":
      return `Read the timeline of ${s("record")}`;
    case "get_subscription":
      return `Read subscription ${s("subscription")}`;
    case "list_invoices":
      return "Listed invoices";
    case "get_invoice":
      return `Read invoice ${s("invoice")}`;
    case "list_payments":
      return "Listed payments";
    case "get_payment_attempts":
      return `Read payment intent ${s("payment_intent")}`;
    case "get_metrics":
      return "Read the revenue metrics";
    case "explain_invoice":
      return `Explained invoice ${s("invoice")}`;
    case "explain_payment":
      return s("payment")
        ? `Explained payment ${s("payment")}`
        : `Explained the payments on ${s("invoice")}`;
    case "explain_mrr_change":
      return s("start") || s("end")
        ? `Explained MRR from ${s("start") || "…"} to ${s("end") || "today"}`
        : "Explained MRR for the last 30 days";
    case "explain_balance":
      return `Explained the balances of ${s("customer")}`;
    case "preview_subscription_change":
      return `Previewed a change to ${s("subscription")}`;
    case "preview_cancellation":
      return `Previewed cancelling ${s("subscription")}`;
    case "search_docs":
      return `Searched help: ${s("query")}`;
    case "get_api_reference":
      return s("path")
        ? `Read the API reference: ${s("method")} ${s("path")}`
        : `Searched the API reference: ${s("query")}`;
    case "decline_request":
      return s("reason") === "harmful"
        ? "Declined: this is not something the assistant helps with"
        : s("reason") === "prompt_extraction"
          ? "Declined: the assistant does not share its instructions"
          : "Declined: not about your billing or the product";
    case "find_screen":
      return `Found the screen: ${s("query")}`;
    case "search_source":
      return "Checked how the product works";
    case "read_api":
      return `Read ${s("path")}`;
    case "query_records":
      return `Counted ${s("resource") || "records"}${Array.isArray(a.group_by) && a.group_by.length ? ` by ${(a.group_by as string[]).join(", ")}` : ""}`;
    case "research":
      return `Researched: ${s("query")}`;
    default:
      return name;
  }
}
