import { headers } from "next/headers";
import { listBusinesses } from "@/lib/api";
import { NotFoundPage } from "@/components/error-state-not-found";

/**
 * A record that does not exist in this business (a detail page's `notFound()`), or a path
 * under it that no route claims (`[...rest]/page.tsx`). Names the business, not its id.
 */
export default async function BusinessNotFound() {
  const path = (await headers()).get("x-tmb-path") ?? "/";
  const biz = /^\/businesses\/([^/]+)/.exec(path)?.[1] ?? "";
  const name = await listBusinesses()
    .then((r) => r.data.find((b) => b.id === biz)?.name ?? "Business")
    .catch(() => "Business");
  return <NotFoundPage path={path} business={{ id: biz, name }} />;
}
