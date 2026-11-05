import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";

// The old Ops view was split into Home (dunning + attention), Invoices, and
// Payments. Keep the route as a redirect so old links don't 404.
export default async function OpsRedirect({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("reports:view", "ops");

  const { biz } = await params;
  redirect(`/businesses/${biz}`);
}
