import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import type { AnalyticsRefused } from "@/lib/analytics-api";

/**
 * A money measure refused at ORG scope because it holds more than one currency and the
 * engine never invents a rate to sum them. `refusal.options` is the exact set it can answer
 * — rendered as one-click links, never parsed out of the sentence — plus the sentence
 * itself, verbatim, so a reader sees the real reason rather than a paraphrase.
 */
export function CurrencyRefusal({
  refusal,
  hrefFor,
}: {
  refusal: AnalyticsRefused;
  /** Build the link for picking a given currency — the caller owns the URL shape. */
  hrefFor: (currency: string) => string;
}) {
  return (
    <Alert tone="warning" title="Select a currency to total this across businesses">
      <p>{refusal.message}</p>
      {refusal.options && refusal.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {refusal.options.map((c) => (
            <Link
              key={c}
              href={hrefFor(c)}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
            >
              Report in {c}
            </Link>
          ))}
        </div>
      ) : null}
    </Alert>
  );
}
