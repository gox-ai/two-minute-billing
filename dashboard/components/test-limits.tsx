import Link from "next/link";
import { Alert } from "@/components/ui/alert";
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
        <Link href={`/businesses/${biz}/transfer`} className="font-medium underline">
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

/** The usage rows in the test-data area of the transfer page. */
export function TestLimitsSummary({ limits }: { limits: TestLimits }) {
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
        <dt className="text-muted-foreground">Customers</dt>
        <dd className="tabular-nums">{usageText(limits.customers)}</dd>
        <dt className="text-muted-foreground">Subscriptions</dt>
        <dd className="tabular-nums">{usageText(limits.subscriptions)}</dd>
      </dl>
      <p className="text-muted-foreground">
        All customers count, archived customers too. All subscriptions count, cancelled
        subscriptions too. To make space, delete test data.
      </p>
    </div>
  );
}
