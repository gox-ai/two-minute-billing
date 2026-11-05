import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { SettingsPage, type AttentionItem } from "@/components/settings/settings-layout";
import { listDeclineRules, type DeclineRuleList } from "@/lib/api/decline-rules";
import { DeclineRuleTable } from "@/components/settings/decline-rule-table";

export const dynamic = "force-dynamic";

/**
 * Settings → Error handling. A catalogue of gateway errors with this business's
 * answer per row. The rules are ours and the same for every merchant, so there is no
 * "add a rule" control — the API deliberately offers none.
 */
export default async function DeclineRuleSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  const crumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Error handling" },
  ];
  let list: DeclineRuleList;
  try {
    list = await listDeclineRules(biz);
  } catch (e) {
    return (
      <SettingsPage title="Error handling" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }

  const orphans = list.orphaned_overrides;
  const attention: AttentionItem[] = orphans.length
    ? [
        {
          key: "orphaned",
          tone: "warning",
          title: `${orphans.length} saved ${orphans.length === 1 ? "setting no longer applies" : "settings no longer apply"}`,
          detail: (
            <>
              {orphans.length === 1 ? "It points" : "They point"} at a rule that no longer exists,
              so {orphans.length === 1 ? "it does" : "they do"} not take effect:{" "}
              <span className="font-mono text-xs wrap-anywhere">
                {orphans.map((o) => o.decline_rule).join(", ")}
              </span>
            </>
          ),
        },
      ]
    : [];

  return (
    <SettingsPage
      title="Error handling"
      crumbs={crumbs}
      description="How this business responds to each payment error that a gateway can return. This sets whether we retry the payment and whether we tell the customer why."
      attention={attention}
    >
      <DeclineRuleTable biz={biz} list={list} />
    </SettingsPage>
  );
}
