import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** Any business path no route claims, so `[biz]/not-found.tsx` answers it inside the shell. */
export default function BusinessCatchAll() {
  notFound();
}
