import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { SettingsPage, type AttentionItem } from "@/components/settings/settings-layout";
import {
  listReasonCodes,
  REASON_CODE_APPLIES_TO,
  APPLIES_TO_LABEL,
  type ReasonCode,
  type ReasonCodeAppliesTo,
} from "@/lib/api/reason-codes";
import { DEFAULT_CANCELLATION_REASONS } from "@/lib/reason-code-defaults";
import { ReasonCodeList } from "@/components/settings/reason-code-list";

export const dynamic = "force-dynamic";

// Settings → Reason codes. One card per action that stores a merchant-supplied reason:
// `subscriptions.cancel_reason_code` and `refunds.reason`. Invoice void has no reason
// column, so it is not listed.
const HELP: Record<ReasonCodeAppliesTo, string> = {
  subscription_cancellation:
    "The cancel dialog offers these reasons. The cancellations report groups by them.",
  // The dashboard's refund dialogs take free text; only the API's offered list reads these.
  refund:
    "The reason codes API sends these reasons to your integration. Refunds that you make in this dashboard use a free-text reason instead.",
};

export default async function ReasonCodeSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let all: ReasonCode[];
  try {
    const { data } = await listReasonCodes(biz);
    all = data;
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }

  const byScope = (scope: ReasonCodeAppliesTo) =>
    all.filter((r) => r.applies_to === scope).sort((a, b) => a.position - b.position);

  // With every configured code disabled the engine offers the built-in list again —
  // which the operator who disabled them almost certainly did not intend.
  const cancel = byScope("subscription_cancellation");
  const attention: AttentionItem[] =
    cancel.length > 0 && cancel.every((r) => !r.enabled)
      ? [
          {
            key: "all-cancel-disabled",
            tone: "warning",
            title: "The cancel dialog offers the built-in reasons",
            detail:
              "Every cancellation code you configured is disabled, so operators see the seven built-in reasons instead. Enable at least one to offer your own list.",
            actions: (
              <a
                href="#subscription_cancellation"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Review cancellation codes
              </a>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Reason codes"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Reason codes" },
      ]}
      description="The reasons we offer when someone cancels a subscription or issues a refund. A stable code, not free text, lets churn reports group by reason."
      attention={attention}
    >
      {REASON_CODE_APPLIES_TO.map((scope) => (
        <ReasonCodeList
          key={scope}
          biz={biz}
          appliesTo={scope}
          title={APPLIES_TO_LABEL[scope]}
          rows={byScope(scope)}
          help={HELP[scope]}
          // Shown greyed when nothing is configured, so they read as built-in fallbacks.
          fallback={scope === "subscription_cancellation" ? DEFAULT_CANCELLATION_REASONS : []}
          emptyText="None configured. The list stays empty until you create a code."
        />
      ))}

      <p className="m-0 max-w-3xl text-sm leading-normal text-muted-foreground">
        When you disable or delete a code, we stop offering it. Records that already have the code
        keep it, because we store it as text. A disabled code stays in this list, so you can enable
        it again.
      </p>
    </SettingsPage>
  );
}
