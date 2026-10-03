import { useState } from 'react'

/**
 * A number that says how many: Threads that need the Person, items done. When it changes, the new
 * value steps up into place (`motion-tick`), so a count that moved is seen to have moved. The
 * first value it is drawn with does not: a number that was already true is not news.
 *
 * Each change is a new element, which is what lets its starting style play; `changes` is how many
 * there have been, kept by adjusting state while rendering, React's way to follow a prop without
 * an effect. Figures are tabular so the digits beside it do not shift as it changes.
 */
export function Count({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const [changes, setChanges] = useState(0)
  if (shown !== value) {
    setShown(value)
    setChanges(changes + 1)
  }
  return (
    <span key={changes} className={changes === 0 ? 'tabular-nums' : 'motion-tick tabular-nums'}>
      {value}
    </span>
  )
}
