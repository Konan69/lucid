import { cn } from '@/ui/cn'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-xs bg-surface-2 px-1 font-sans text-meta font-title text-ink-3 select-none in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
