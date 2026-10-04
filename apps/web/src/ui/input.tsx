import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from '@/ui/cn'

/**
 * shadcn's Input as Vivid's field: a well, held by an edge that turns primary with focus.
 * `compact` is the 32 px field that sits in a row beside buttons (a form's own field is 40 px);
 * `mono` is for what is copied character by character: a key, a code.
 */
function Input({
  className,
  type,
  compact = false,
  mono = false,
  ...props
}: React.ComponentProps<'input'> & { compact?: boolean; mono?: boolean }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-control bg-well px-3 text-label text-ink edge outline-none edge-field file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-label file:font-title file:text-ink placeholder:text-muted-foreground focus-visible:edge-primary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:edge-danger',
        compact && 'h-8',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
