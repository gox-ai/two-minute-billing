'use client'

import * as React from 'react'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Client provider boundary: theme + tooltips + global toaster (with undo
 * affordance support). `TooltipProvider` is mounted once here so callers never
 * have to remember it.
 */
export function Providers({
  children,
  forcedTheme,
}: {
  children: React.ReactNode
  /**
   * Pin the theme for this tree and disable switching. The storefront passes
   * `light`: those pages are a MERCHANT's brand surface, and a merchant supplies
   * one logo for one background — see the storefront layout.
   */
  forcedTheme?: 'light' | 'dark'
}) {
  return (
    <ThemeProvider forcedTheme={forcedTheme}>
      <TooltipProvider>
        {children}
        <Toaster richColors closeButton position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  )
}
