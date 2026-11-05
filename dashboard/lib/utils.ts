import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Tailwind classes for a native `<input>`/`<select>` so server-action forms
 * (which rely on native FormData posting via `name`) match the shadcn look
 * without pulling in the controlled Radix Select.
 */
export const fieldClass =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
