import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Hosted pages split into Checkout and Customer portal. Keep old bookmarks working. */
export default async function HostedPagesRedirect({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  redirect(`/businesses/${biz}/settings/checkout`);
}
