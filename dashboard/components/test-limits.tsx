import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Chip } from "@/components/patterns/chip";
import { getTestLimits, type TestLimits, type TestLimitUsage } from "@/lib/api/test-limits";

type Kind = "customers" | "subscriptions";

/** Warn from this share of the limit. */
const NEAR = 0.9;

const fmt = (n: number) => n.toLocaleString("en-US");

/** "812 of 1,000", or "812 (no limit)". */
const usageText = (u: TestLimitUsage) =>
  u.limit == null ? `${fmt(u.used)} (no limit)` : `${fmt(u.used)} of ${fmt(u.limit)}`;

/**
 * Banner on a test business's customer or subscription list when it is near or at its limit.
 * Renders nothing on a live business (no fetch) or below the threshold.
 */
export async function TestLimitNotice({
  biz,
  kind,
  livemode,
}: {
  biz: string;
  kind: Kind;
  livemode: string | undefined;
}) {
  if (livemode !== "test") return null;
  const limits = await getTestLimits(biz);
  const u = limits?.[kind];
  if (!u || u.limit == null || u.used < u.limit * NEAR) return null;
  const at = u.used >= u.limit;
  const noun = kind === "customers" ? "customer" : "subscription";
  return (
    <Alert
      tone={at ? "error" : "warning"}
      className="mb-6"
      title={`This test business is ${at ? "at" : "near"} its ${noun} limit`}
      action={
        <Link href={`/businesses/${biz}/transfer?tab=test`} className="font-medium underline">
          View test data
        </Link>
      }
    >
      It has {usageText(u)} {kind}.{" "}
      {at
        ? `You cannot create more ${kind}. To make space, delete test data, or contact us to increase the limit.`
        : `When it reaches the limit, you cannot create more ${kind}. To make space, delete test data.`}
    </Alert>
  );
}

/** One usage row: the figures, and a bar that turns amber from the warning threshold. */
function UsageRow({ label, u }: { label: string; u: TestLimitUsage }) {
  const near = u.limit != null && u.used >= u.limit * NEAR;
  const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 font-medium">
          {label}
          {near ? (
            <Chip tone={u.used >= (u.limit ?? 0) ? "red" : "tan"}>
              {u.used >= (u.limit ?? 0) ? "At the limit" : "Near the limit"}
            </Chip>
          ) : null}
        </span>
        <span className="tabular-nums">{usageText(u)}</span>
      </div>
      {u.limit != null ? (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={u.limit}
          aria-valuenow={u.used}
        >
          <div
            className={near ? "h-full bg-warning" : "h-full bg-solid"}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The usage rows in the test-data tab of the transfer page. Rows of a `SettingsCard`. */
export function TestLimitsSummary({ limits }: { limits: TestLimits }) {
  return (
    <>
      <UsageRow label="Customers" u={limits.customers} />
      <UsageRow label="Subscriptions" u={limits.subscriptions} />
      <p className="m-0 px-5 py-4 text-xs text-muted-foreground">
        All customers count, archived customers too. All subscriptions count, cancelled
        subscriptions too. To make space, delete test data.
      </p>
    </>
  );
}
