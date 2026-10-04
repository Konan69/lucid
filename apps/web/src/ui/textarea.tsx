import * as React from 'react'
import { cn } from '@/ui/cn'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full resize-y rounded-control bg-well px-3 py-2.5 text-label text-ink edge outline-none edge-field placeholder:text-muted-foreground focus-visible:edge-primary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:edge-danger',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
