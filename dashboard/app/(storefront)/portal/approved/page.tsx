import { CheckCircle2, Info } from "lucide-react";
import { NoticeCard } from "../../chrome";

export const metadata = { title: "Billing" };

/**
 * Where a provider sends the buyer back to when the portal is embedded in a business's page. The
 * approval opened in a new tab (a provider page is never framed), and the portal in the frame
 * finishes through "Continue after approval", so this tab only has to say so.
 */
export default async function PortalApprovedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const payment = sp.for === "payment";
  return sp.state === "cancel" ? (
    <NoticeCard
      icon={<Info />}
      title={payment ? "You did not approve the payment" : "You did not approve the payment method"}
    >
      Return to your billing page to select a different method. You can close this tab.
    </NoticeCard>
  ) : (
    <NoticeCard icon={<CheckCircle2 />} tone="success" title="Approval received">
      Return to your billing page and select Continue after approval to finish. You can close this
      tab.
    </NoticeCard>
  );
}
