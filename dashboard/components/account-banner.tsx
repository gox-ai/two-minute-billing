import Link from "next/link";

/**
 * The account bar (0354, 0356): read-only (unpaid, or over the limit by staff approval), over the
 * plan's limit this month (a notice for owners and admins), or live mode locked by staff. The API
 * enforces the first and the last; this is the map.
 */
export function AccountBanner({
  access,
  status,
  reason,
  overLimit,
  canChoosePlan,
}: {
  access: "locked" | "enabled" | undefined;
  status: "active" | "restricted" | undefined;
  reason: "unpaid" | "over_limit" | null | undefined;
  overLimit: boolean | undefined;
  canChoosePlan: boolean;
}) {
  const billing = (label: string) => (
    <Link href="/settings/billing" className="font-semibold underline underline-offset-2">
      {label}
    </Link>
  );
  if (status === "restricted") {
    const over = reason === "over_limit";
    return (
      <div className="z-50 flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive-soft px-3 py-1 text-center text-xs font-medium text-destructive">
        <span>
          <strong className="font-semibold">Read-only</strong> —{" "}
          {over ? "you billed more than your plan covers." : "your plan is not paid."} Your
          customers are still billed.
        </span>
        {canChoosePlan ? (
          billing(over ? "Change plan" : "Pay now")
        ) : (
          <span>
            {over
              ? "Ask an administrator to change the plan."
              : "Ask an administrator to pay the open invoice."}
          </span>
        )}
      </div>
    );
  }
  if (overLimit && canChoosePlan) {
    return (
      <div className="z-50 flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warning-soft px-3 py-1 text-center text-xs font-medium text-warning">
        <span>
          <strong className="font-semibold">Over your plan&apos;s limit</strong> — you billed more
          this month than your plan covers. Your billing continues.
        </span>
        {billing("Change plan")}
      </div>
    );
  }
  if (access !== "locked") return null;
  return (
    <div className="z-50 flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-info-soft px-3 py-1 text-center text-xs font-medium text-info">
      <span>
        <strong className="font-semibold">Live mode is off</strong> — test mode has every feature.
        Contact us to turn live mode on.
      </span>
    </div>
  );
}
