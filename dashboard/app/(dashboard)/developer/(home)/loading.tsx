import { ListLoading } from "@/components/patterns/route-loading";

// Every Developer tab: header with one action, the address strip and tabs, then one table card.
export default function Loading() {
  return <ListLoading cols={6} rows={4} actions={1} />;
}
