import { suggestions } from '../data/fixtures'
import { Face } from '../ui/Face'

export function EmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-(--thread-max-w) flex-1 animate-rise-in flex-col items-center justify-center px-6">
      <Face size={56} mood="happy" />
      <h1 className="mt-5 text-page font-title text-ink">Hi, I&apos;m Vivid.</h1>
      <p className="mt-1 text-body text-ink-3">What should I take off your plate?</p>
      <ul className="mt-8 grid w-full gap-2 sm:grid-cols-3">
        {suggestions.map((s) => (
          <li key={s}>
            <button className="size-full rounded-card bg-surface-3 p-4 text-left text-label text-ink-2 shadow-ring-xs transition-press duration-(--dur-fast) hover:bg-wash-hover hover:text-ink hover:shadow-ring-sm active:scale-98">
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
