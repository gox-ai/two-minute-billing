import { redirect } from "next/navigation";

/** The delivery report moved into Reports. The old link keeps working. */
export default async function EmailDeliveryReportRedirect({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  redirect(`/businesses/${biz}/reports/emails`);
}
