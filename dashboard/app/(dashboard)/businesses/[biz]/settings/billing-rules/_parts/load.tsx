import { getBusiness } from "@/lib/api/business-settings";
import type { Business } from "@/lib/api";
import { ErrorState } from "@/components/states";

/** The business for a billing-rules page, or the error state to render instead. */
export async function loadRuleBusiness(
  biz: string,
): Promise<{ b: Business; error?: never } | { b?: never; error: React.ReactNode }> {
  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return {
      error: (
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      ),
    };
  }
  if (!b)
    return {
      error: (
        <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />
      ),
    };
  return { b };
}
