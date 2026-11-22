import { redirect } from "next/navigation";

/** An old team alert confirmation link (0495). The token is not used: the page says why. */
export const dynamic = "force-dynamic";

export function GET() {
  redirect("/team-alerts/confirm");
}
