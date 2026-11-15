import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** Any path no route claims, so the shell's `not-found.tsx` answers it instead of the bare framework page. */
export default function CatchAll() {
  notFound();
}
