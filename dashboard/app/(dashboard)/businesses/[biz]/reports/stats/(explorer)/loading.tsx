import { StatsLibraryLoading } from "@/components/reports/skeletons";

/**
 * In a route group so it covers only the library — `[key]` beside it is a stat's own page and
 * keeps its own.
 */
export default function Loading() {
  return <StatsLibraryLoading />;
}
