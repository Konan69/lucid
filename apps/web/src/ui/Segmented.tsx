import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * A choice between a few things that are all visible at once: which shelf, which trigger, grid or
 * list. It is a radio group to assistive tech, since exactly one option is always chosen. The
 * chosen option is raised; the others answer to hover and to the keyboard focus ring.
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
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-row px-2 text-label transition-colors duration-(--dur-fast)',
            option.value === value
              ? 'bg-surface-3 text-ink edge'
              : 'text-ink-3 hover:bg-wash-hover hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
