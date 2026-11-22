import { sourceByPhrase } from "../components/audit/labels";

/** What created a record (engine `created_through`). */
export interface CreatedThrough {
  source: string;
  actor: string | null;
}

/**
 * How a record's origin reads: "Through the API", "In the customer portal", "By the billing clock".
 * A member in the dashboard is named: "In the dashboard by sam@example.com".
 */
export function createdThroughLabel(c: CreatedThrough | null | undefined): string {
  if (!c) return "Not recorded";
  if (c.source === "dashboard" && c.actor?.includes("@")) return `In the dashboard by ${c.actor}`;
  const phrase = sourceByPhrase(c.source, c.actor);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
