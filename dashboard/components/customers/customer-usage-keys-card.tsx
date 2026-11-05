import { RecordCard } from "@/components/patterns/record-page";
import { Alert } from "@/components/ui/alert";
import { listUsageKeys } from "@/lib/api/meters";
import { fmtDate } from "@/lib/format";
import { AddUsageKeyDialog, RemoveUsageKeyButton } from "./customer-usage-keys-actions";

/**
 * The keys an app sends in usage events to name this customer. The customer id itself
 * always works, so it is listed first and cannot be removed.
 */
export async function CustomerUsageKeysCard({
  biz,
  cus,
  tz,
  canManage,
}: {
  biz: string;
  cus: string;
  tz?: string | null;
  canManage: boolean;
}) {
  const keys = await listUsageKeys(biz, cus).catch(() => null);
  return (
    <RecordCard
      id="usage-keys"
      title="Usage keys"
      meta={keys ? `${keys.data.length + 1} key${keys.data.length ? "s" : ""}` : undefined}
      actions={canManage && keys ? <AddUsageKeyDialog biz={biz} cus={cus} /> : null}
    >
      {keys ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Usage events name a customer with one of these keys. Use a key that your app already
            has, for example a user, workspace or API key ID.
          </p>
          <ul className="flex flex-col divide-y divide-border/60">
            <li className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{cus}</span>
              <span className="text-xs text-muted-foreground">Customer ID · always works</span>
            </li>
            {keys.data.map((k) => (
              <li key={k.key} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{k.key}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Added {fmtDate(k.created_at, tz)}
                </span>
                {canManage ? <RemoveUsageKeyButton biz={biz} cus={cus} usageKey={k.key} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Alert tone="error">We could not load the usage keys. Reload the page.</Alert>
      )}
    </RecordCard>
  );
}
