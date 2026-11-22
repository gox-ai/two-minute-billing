"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { setupHiddenCookie } from "@/lib/setup-readiness";

/** Hides the setup checklist on this business for this browser. */
export async function hideSetupChecklistAction(biz: string): Promise<void> {
  (await cookies()).set(setupHiddenCookie(biz), "1", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
  });
  revalidatePath(`/businesses/${biz}`);
}
