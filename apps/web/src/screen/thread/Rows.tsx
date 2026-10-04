import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The lines the card around Vivid is written in (`About.tsx` and its tabs): a section's name, a
 * row that goes somewhere, a fact that does not, a text action, and a read that failed. They are
 * here so every tab draws its lines on the same edges with the same weights.
 */

/** A section's name: quiet, in sentence case, so the rows under it carry the weight. */
export function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mb-1.5 text-title font-title text-ink-3">
      {children}
    </h3>
  )
}

/** A link-weight action under a list: text, so it is not mistaken for another row. */
export function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 cursor-pointer rounded-xs px-1 py-0.5 text-ink-3 transition-press duration-(--dur-fast) hover:text-ink focus-visible:text-ink active:scale-96"
    >
      {children}
    </button>
  )
}

/** A failed read says so, and retries only that one subscription; the other sections stay warm. */
export function Refused({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <p className="py-1.5 text-label text-ink-3" role="status">
      {children} <TextButton onClick={onRetry}>Try again</TextButton>
    </p>
  )
}

/** What a line of the card says: an icon, what the thing is, and where it stands. */
export interface Entry {
  readonly icon: ReactNode
  readonly title: string
  readonly detail: string
  /** A green dot on the icon while the thing is on or connected. */
  readonly lit: boolean
}

/** The icon and the two lines of text that a `Row` and a `Fact` share. */
function EntryBody({ icon, title, detail, lit }: Entry) {
  return (
    <>
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center text-ink-2">
        {icon}
        {lit && (
          <i
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-success ring-2 ring-surface-3"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title font-title text-ink">{title}</span>
        <span className="block truncate text-label font-meta text-ink-3">{detail}</span>
      </span>
    </>
  )
}

/**
 * One thing around Vivid that goes somewhere: its entry, and a chevron because it does. The hover
 * fill reaches 8 beyond the text on each side so the text keeps the heading's edge.
 */
export function Row({ entry, onClick }: { entry: Entry; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/row -mx-2 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-row px-2 py-1 text-left transition-press duration-(--dur-fast) outline-none hover:bg-wash-hover focus-visible:bg-wash-hover active:scale-98"
    >
      <EntryBody {...entry} />
      <ChevronRight className="size-4 shrink-0 text-ink-4 transition-colors duration-(--dur-fast) group-hover/row:text-ink-3" />
    </button>
  )
}

/**
 * One thing around Vivid that goes nowhere from here: the same entry on the same edges as a `Row`,
 * with no chevron, no fill and no pointer, so it does not read as something to press.
 */
export function Fact({ entry }: { entry: Entry }) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 py-1">
      <EntryBody {...entry} />
    </div>
  )
}
