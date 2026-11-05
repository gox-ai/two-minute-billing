import Link from 'next/link'
import { cn } from '@/lib/utils'

/** A two-state pill that flips the ?archived= query param to show/hide archived rows. */
export function ShowArchivedToggle({ basePath, showing }: { basePath: string; showing: boolean }) {
  return (
    <Link
      href={showing ? basePath : `${basePath}?archived=1`}
      className={cn(
        'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
        showing
          ? 'border-primary/30 bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {showing ? 'Showing archived' : 'Show archived'}
    </Link>
  )
}
