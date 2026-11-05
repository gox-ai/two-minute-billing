'use client'

import * as React from 'react'
import { useFormStatus } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Submit button with automatic pending spinner (works in any server-action form). */
export function SubmitButton({
  children,
  variant = 'default',
  size,
  className,
  disabled,
}: {
  children: React.ReactNode
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
  className?: string
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size={size} className={className} disabled={disabled || pending}>
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </Button>
  )
}
