import { Radio } from '@base-ui/react/radio'
import type { MouseEvent, ReactNode } from 'react'
import { cn } from './cn'
import { byKeyboard, slide } from './motion'
import { RadioGroup } from './radio-group'

/**
 * Plays the raised mark from the option that was chosen to the one just clicked. Each option
 * carries its own mark, drawn only when it is chosen; the clicked one's is played from where the
 * old one sits, so it reads as one mark crossing over. Both places are read here, before React
 * has drawn the change, and the travel is a transform, so nothing is laid out while it moves.
 * From the keyboard the choice simply changes.
 */
function cross(event: MouseEvent<HTMLElement>) {
  if (byKeyboard(event)) return
  const group = event.currentTarget.parentElement
  const from = group === null ? null : group.querySelector('[aria-checked="true"] [data-mark]')
  const to = event.currentTarget.querySelector('[data-mark]')
  if (from === null || to === null || from === to) return
  slide(to, from.getBoundingClientRect())
}

/**
 * A choice between a few things that are all visible at once: which shelf, which trigger, grid or
 * list. Exactly one option is always chosen, so it is shadcn's `RadioGroup` (Base UI's radio
 * group: one tab stop, the arrow keys move the choice) with each radio drawn as a segment instead
 * of a dot. The chosen option is raised, and the raised mark slides to whichever is chosen next
 * (T3 Code mobile's `SegmentedControl`, 200 ms); the others answer to hover and to the keyboard
 * focus ring.
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
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={onChange}
      className="inline-flex w-auto items-center gap-0 rounded-control bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-label={option.name}
          onClick={cross}
          className={cn(
            'relative inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1.5 rounded-row px-2 text-label transition-colors duration-(--dur-fast)',
            option.value === value ? 'text-ink' : 'text-ink-3 hover:bg-accent hover:text-ink',
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
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
