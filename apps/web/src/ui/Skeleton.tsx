const OUTLINE = {
  row: { list: 'flex flex-col gap-1', item: 'h-12 rounded-row bg-surface-2' },
  card: { list: 'grid gap-2.5 sm:grid-cols-2', item: 'h-28 rounded-card bg-surface-2' },
} satisfies Record<string, { list: string; item: string }>

/**
 * What a list draws while its live query has not answered yet: the outline of what is coming.
 * It is deliberately still. A shimmer would repaint every frame for as long as the socket takes,
 * and the wait is normally too short to need one. It is never the empty state: empty is an answer.
 */
export function Skeleton({ of, count }: { of: keyof typeof OUTLINE; count: number }) {
  const { list, item } = OUTLINE[of]
  return (
    <ul aria-hidden className={list}>
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className={item} />
      ))}
    </ul>
  )
}
