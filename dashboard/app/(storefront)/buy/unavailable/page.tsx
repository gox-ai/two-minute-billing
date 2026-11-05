import { Clock } from "lucide-react";
import { NoticeCard } from "../../chrome";

export const metadata = { title: "Payment link" };

/** Where `/buy/<link>` lands when the link is unknown, archived, or opened too often. */
export default async function PaymentLinkUnavailable({
  searchParams,
}: {
  searchParams: Promise<{ busy?: string }>;
}) {
  const { busy } = await searchParams;
  return busy ? (
    <NoticeCard icon={<Clock />} title="Too many attempts">
      You opened this link too many times. Wait a few minutes, then try again.
    </NoticeCard>
  ) : (
    <NoticeCard icon={<Clock />} title="This payment link is not available">
      The business stopped this link or changed what it sells. Ask the business for a new link.
    </NoticeCard>
  );
}
