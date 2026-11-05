import Link from "next/link";
import type { ConvertedResult } from "@/components/analytics/org/conversion";
import { excludedBusinesses } from "@/components/analytics/org/conversion";
import { PageNote } from "@/components/analytics/layout";

/**
 * The page's last line: when the figures were computed, and what the conversion had to drop.
 *
 * A currency with no rate is EXCLUDED from the roll-up and named here — never summed in as
 * zero, which would read as a business earning nothing. The businesses behind those currencies
 * are named too, because that is the sentence an operator can act on.
 *
 * Deliberately a line, not a panel: this is the caveat on a figure, not a finding.
 */
export function ConversionNote({
  result,
  businesses,
}: {
  result: ConvertedResult;
  businesses: ReadonlyArray<{
    id: string;
    name: string;
    default_currency: string | null;
    currencies?: string[] | null;
  }>;
}) {
  const missing = result.missing_rates ?? [];
  const dropped = excludedBusinesses(businesses, missing);
  const base = result.currency;

  // Named, but not at any length: the currencies are the actionable fact, and a line that lists
  // twelve businesses stops being a caption. Three, then a count.
  const names =
    dropped.length <= 3
      ? dropped.map((b) => b.name).join(", ")
      : `${dropped
          .slice(0, 3)
          .map((b) => b.name)
          .join(", ")} and ${dropped.length - 3} more`;

  if (!base && missing.length === 0) return null;

  return (
    <PageNote
      warning={
        missing.length > 0 && base ? (
          <>
            {missing.join(", ")} {missing.length === 1 ? "has" : "have"} no reporting rate. So the{" "}
            {base} roll-up excludes{" "}
            {dropped.length > 0
              ? names
              : `what is billed in ${missing.length === 1 ? "it" : "them"}`}
            . It does not use a value of zero.{" "}
            {/* The design asks for "Set rate" here. There is no org-level rate editor to send
                anyone to: an organization's rates are refreshed from the FX provider, and the
                only operator control over this roll-up is the reporting currency. So the link
                names what it actually opens. */}
            <Link href="/settings" className="text-primary hover:underline">
              Reporting settings
            </Link>
          </>
        ) : undefined
      }
    >
      {base ? `Consolidated in ${base}` : null}
    </PageNote>
  );
}
