import * as React from 'react'
import Link from 'next/link'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

/**
 * Breadcrumb. Every detail page in the app hand-assembles its own crumb row
 * (`business / Invoices / INV-2068`) as bare spans and slashes, so none of them
 * announce themselves as navigation and the separator is real text that screen
 * readers read aloud.
 *
 * Here the separator is `aria-hidden` and the trail is a proper `<nav><ol>`,
 * with the current page marked `aria-current="page"` rather than merely styled.
 */
function Breadcrumb({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      data-slot="breadcrumb"
      aria-label="Breadcrumb"
      className={cn('min-w-0', className)}
      {...props}
    />
  )
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn('flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="breadcrumb-item" className={cn('inline-flex items-center', className)} {...props} />
}

function BreadcrumbLink({
  className,
  href,
  asChild,
  ...props
}: React.ComponentProps<'a'> & { asChild?: boolean }) {
  if (asChild) {
    return <Slot.Root data-slot="breadcrumb-link" className={cn('hover:text-foreground', className)} {...props} />
  }
  return (
    <Link
      data-slot="breadcrumb-link"
      href={href ?? '#'}
      className={cn('truncate transition-colors hover:text-foreground', className)}
      {...props}
    />
  )
}

/** The trailing crumb — the page you are on. Not a link. */
function BreadcrumbPage({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="breadcrumb-page"
      aria-current="page"
      className={cn('truncate font-medium text-foreground', className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({ className, children, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden
      className={cn('text-border select-none', className)}
      {...props}
    >
      {children ?? '/'}
    </li>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
}
