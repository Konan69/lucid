import { X } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { said } from '../data/said'

/**
 * The sentences the app says at the foot of the window (see `data/said.ts`). Each rises a little
 * as it arrives, from where it will sit, and goes at once when dismissed or when its time is up:
 * the arrival is worth a moment of motion, the leaving is not.
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
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-panel py-1.5 pr-1.5 pl-3.5 text-label text-ink smooth-shadow-ring-lg glass transition-pop duration-(--dur-base) ease-out starting:translate-y-2 starting:opacity-0"
        >
          <span className="min-w-0 flex-1 text-pretty">{saying.words}</span>
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
