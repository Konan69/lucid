import type { MouseEvent, ReactNode } from 'react'
import { cn } from './cn'
import { byKeyboard, slide } from './motion'

/**
 * Plays the raised mark from the option that was chosen to the one just clicked. Each option
 * carries its own mark, drawn only when it is chosen; the clicked one's is played from where the
 * old one sits, so it reads as one mark crossing over. Both places are read here, before React
 * has drawn the change, and the travel is a transform, so nothing is laid out while it moves.
 * From the keyboard the choice simply changes.
 */
function cross(event: MouseEvent<HTMLButtonElement>) {
  if (byKeyboard(event)) return
  const group = event.currentTarget.parentElement
  const from = group === null ? null : group.querySelector('[aria-checked="true"] [data-mark]')
  const to = event.currentTarget.querySelector('[data-mark]')
  if (from === null || to === null || from === to) return
  slide(to, from.getBoundingClientRect())
}

/**
 * A choice between a few things that are all visible at once: which shelf, which trigger, grid or
 * list. It is a radio group to assistive tech, since exactly one option is always chosen. The
 * chosen option is raised, and the raised mark slides to whichever is chosen next (T3 Code
 * mobile's `SegmentedControl`, 200 ms); the others answer to hover and to the keyboard focus ring.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** What is being chosen, for a screen reader. It is not drawn. */
  label: string
  value: Value
  options: ReadonlyArray<{
    readonly value: Value
    readonly label: ReactNode
    readonly name: string
  }>
  onChange: (value: Value) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center rounded-control bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.name}
          onClick={(event) => {
            cross(event)
            onChange(option.value)
          }}
          className={cn(
            'relative inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-row px-2 text-label transition-colors duration-(--dur-fast)',
            option.value === value ? 'text-ink' : 'text-ink-3 hover:bg-wash-hover hover:text-ink',
          )}
        >
          {/* The raised mark. Every option has one so the next can be played in from this one;
              only the chosen option's is visible. While it slides, the animation holds it
              visible itself, so it shows from the click and not from the next render. */}
          <i
            data-mark
            className={cn(
              'absolute inset-0 rounded-row bg-surface-3 edge',
              option.value !== value && 'opacity-0',
            )}
          />
          <span className="relative inline-flex items-center gap-1.5">{option.label}</span>
        </button>
      ))}
    </div>
  )
}
