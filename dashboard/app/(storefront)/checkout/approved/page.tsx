import { CheckCircle2, Info } from "lucide-react";
import { NoticeCard } from "../../chrome";

export const metadata = { title: "Checkout" };

/**
 * Where a provider sends the buyer back to when the checkout is embedded in a business's page.
 * The approval was opened in a new tab (a provider page is never framed) and the checkout in the
 * frame finishes through "Continue after approval", so this tab only has to say so.
 */
export default async function ApprovedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cancelled = (await searchParams).state === "cancel";
  return cancelled ? (
    <NoticeCard icon={<Info />} title="You did not approve the payment method">
      Return to the checkout to select a different method. You can close this tab.
    </NoticeCard>
  ) : (
    <NoticeCard icon={<CheckCircle2 />} tone="success" title="Approval received">
      Return to the checkout and select Continue after approval to finish. You can close this tab.
    </NoticeCard>
  );
}
