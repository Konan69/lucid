import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { Option } from 'effect'
import { live, useLiveValue } from '../data/live'
import { startThread } from '../data/threads'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'

/**
 * The first screen: Vivid, and somewhere to write. There is nothing to set up and nothing to
 * choose. Whatever the Person types becomes a Thread; the suggestions are things they could say,
 * drawn from their own Tasks, Routines and Library, and a fresh account gets four that work with
 * nothing connected.
 */
export function First({ me }: { me: MeResponse }) {
  const suggestions = useLiveValue(live.suggestions)
  const first = me.person.name.trim().split(/\s+/u)[0]
  const where = Workspace.match(me.workspace, {
    Personal: () => 'What should I take off your plate?',
    Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
  })
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <div className="mx-auto flex w-full max-w-(--thread-max-w) flex-1 animate-rise-in flex-col items-center justify-center px-6">
        <Face size={56} mood="happy" />
        <h1 className="mt-5 text-page font-title text-ink">
          {first === undefined || first.length === 0 ? 'Hi.' : `Hi, ${first}.`}
        </h1>
        <p className="mt-1 text-body text-ink-3">{where}</p>
        <ul className="mt-8 grid w-full gap-2 sm:grid-cols-2">
          {Option.match(suggestions, {
            onNone: () => [],
            onSome: (value) => value.suggestions,
          }).map((suggestion) => (
            <li key={suggestion.text}>
              <button
                onClick={() => startThread(suggestion.text)}
                className="flex size-full cursor-pointer flex-col gap-1 rounded-card bg-surface-3 p-4 text-left smooth-shadow-ring-xs transition-press duration-(--dur-fast) hover:bg-wash-hover active:scale-98"
              >
                <span className="text-label text-ink">{suggestion.text}</span>
                <span className="text-meta font-meta text-ink-3">{suggestion.reason}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Composer
        working={false}
        onSend={(text) => startThread(text)}
        onStop={() => undefined}
      />
    </section>
  )
}
