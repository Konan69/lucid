import { Option } from 'effect'
import { X } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { said } from '../data/said'

/**
 * The sentences the app says at the foot of the window (see `data/said.ts`). Each comes up from
 * below and leaves the way it came, faster (`motion-toast`): a sentence that vanished mid-read
 * looked like a fault, and one that leaves by the edge it entered is plainly done. While it
 * leaves it cannot be pressed.
 */
export function Sayings() {
  const sayings = useSyncExternalStore(said.subscribe, said.all)
  if (sayings.length === 0) return null
  return (
    <ul className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4">
      {sayings.map((saying) => (
        <li
          key={saying.id}
          role="status"
          data-leaving={saying.leaving ? '' : undefined}
          inert={saying.leaving}
          className="pointer-events-auto flex max-w-md motion-toast items-center gap-2 rounded-panel py-1.5 pr-1.5 pl-3.5 text-label text-ink lift glass"
        >
          <span className="min-w-0 flex-1 text-pretty">{saying.words}</span>
          {Option.isSome(saying.action) && (
            <button
              onClick={() => {
                said.dismiss(saying.id)
                // Read once more here: the handler is only reached when there is an action.
                Option.map(saying.action, (action) => action.go())
              }}
              className="shrink-0 cursor-pointer rounded-control px-2 py-1 font-title text-primary-ink transition-colors duration-(--dur-fast) hover:bg-wash-hover"
            >
              {saying.action.value.label}
            </button>
          )}
          <button
            aria-label="Dismiss"
            onClick={() => said.dismiss(saying.id)}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}
