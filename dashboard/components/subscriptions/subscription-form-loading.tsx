import { Skeleton } from "@/components/ui/skeleton";

/** Card with a title bar and `rows` field placeholders. */
function CardBones({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-5 py-3.5">
        <Skeleton className="h-3.5 w-28" />
      </div>
      <div className="flex flex-col gap-5 px-5 py-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The subscription create/change form: crumbs, title, cards beside the summary. */
export function SubscriptionFormLoading({ cards = [1, 3, 4, 2] }: { cards?: number[] }) {
  return (
    <div aria-busy="true" aria-label="Loading form" className="flex flex-col gap-6">
      <Skeleton className="h-3.5 w-64" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {cards.map((rows, i) => (
            <CardBones key={i} rows={rows} />
          ))}
        </div>
        <CardBones rows={3} />
      </div>
    </div>
  );
}
