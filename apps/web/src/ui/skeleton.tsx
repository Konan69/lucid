import { cn } from '@/ui/cn'

/**
 * shadcn's Skeleton: one block standing where something will be. Vivid's is deliberately still.
 * shadcn's pulses, and a pulse repaints every frame for as long as the socket takes, while the
 * wait is normally too short to need one.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('rounded-row bg-muted', className)} {...props} />
}

const OUTLINE = {
  row: { list: 'flex flex-col gap-1', item: 'h-12 rounded-row' },
  card: { list: 'grid gap-2.5 sm:grid-cols-2', item: 'h-28 rounded-card' },
} satisfies Record<string, { list: string; item: string }>

/**
 * What a list draws while its live query has not answered yet: the outline of what is coming.
 * It is never the empty state: empty is an answer.
 */
function SkeletonList({ of, count }: { of: keyof typeof OUTLINE; count: number }) {
  const { list, item } = OUTLINE[of]
  return (
    <div aria-hidden className={list}>
      {Array.from({ length: count }, (_, index) => (
        // The blocks are identical and never reordered, so their place is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Skeleton key={index} className={item} />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonList }
