import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/ui/cn'

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-control px-3 py-2 text-left text-label has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-1.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-surface-2 text-ink',
        destructive:
          'bg-danger-soft text-danger *:data-[slot=alert-description]:text-danger *:[svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Alert }
