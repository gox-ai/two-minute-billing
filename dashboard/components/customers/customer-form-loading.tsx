import { Skeleton } from "@/components/ui/skeleton";

function CardBones({ fields, wide = false }: { fields: number; wide?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-5 py-3.5">
        <Skeleton className="h-4 w-36" />
      </div>
      <div className={`grid grid-cols-1 gap-x-4 gap-y-5 px-5 py-4 ${wide ? "" : "sm:grid-cols-2"}`}>
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The customer create/edit frame: crumbs, title, cards beside a summary, sticky footer. */
export function CustomerFormLoading() {
  return (
    <div aria-busy="true" aria-label="Loading form" className="flex flex-col gap-6">
      <Skeleton className="h-3.5 w-56" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <CardBones fields={6} />
          <CardBones fields={5} />
          <CardBones fields={4} wide />
        </div>
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-5 py-3.5">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-14 w-full" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
