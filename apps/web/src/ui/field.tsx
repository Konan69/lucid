import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/ui/cn'

import { Label } from '@/ui/label'

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        'group/field-group @container/field-group flex w-full flex-col gap-4 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4',
        className,
      )}
      {...props}
    />
  )
}

const fieldVariants = cva('group/field flex w-full gap-2 data-[invalid=true]:text-destructive', {
  variants: {
    orientation: {
      vertical: 'flex-col *:w-full [&>.sr-only]:w-auto',
      horizontal:
        'flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
      responsive:
        'flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
})

function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border hover:has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:bg-input/40 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-2 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/30 *:data-[slot=field]:p-2',
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col',
        className,
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        'text-left text-label leading-normal font-normal text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5',
        'last:mt-0 nth-last-2:-mt-1',
        '[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
        className,
      )}
      {...props}
    />
  )
}

/**
 * What was wrong with an answer, said under the field it belongs to. `role="alert"` has a screen
 * reader say it when it appears. shadcn's version also took a form library's `errors` array;
 * Vivid's forms state one sentence, so it takes only children and is absent when there are none.
 */
function FieldError({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-label font-meta text-destructive', className)}
      {...props}
    />
  )
}

export { Field, FieldLabel, FieldDescription, FieldError, FieldGroup }
