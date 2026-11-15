import { headers } from "next/headers";
import { NotFoundPage } from "@/components/error-state-not-found";

/**
 * Unknown organization-level routes and `notFound()` from an org page, inside the shell.
 * Unknown URLs reach it through `[...rest]/page.tsx`: a root `not-found.tsx` cannot exist
 * here because each route group owns its own `<html>`.
 */
export default async function NotFound() {
  const path = (await headers()).get("x-tmb-path") ?? "/";
  return <NotFoundPage path={path} />;
}
