import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, greetingAt, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { useState, useSyncExternalStore } from 'react'
import { live, useLiveValue } from '../data/live'
import { onboarding } from '../data/onboarding'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Face } from '../ui/Face'
import { Checklist } from './first/Checklist'
import { Opening } from './first/Opening'
import { Composer } from './thread/Composer'

/**
 * Home: a Thread that does not exist yet. Whatever the Person types becomes one.
 *
 * To someone who has never written to Vivid it is laid out as their first Thread, and Vivid has
 * already spoken in it (`Opening`): the conversation fills the page and the composer is at its
 * foot, where it is in every Thread. What they write, or a job they pick, starts the real Thread,
 * which keeps Vivid's opening above it.
 *
 * To everyone else it is Vivid, a greeting and the composer in the middle of the page, where the
 * eye already is, with what is left of getting started under it until that is done or closed.
 * There are no suggestion cards: four generic ones used to sit here and were filler.
 */
export function First({ me }: { me: MeResponse }) {
  const threads = useLiveValue(live.threads)
  // New means no Thread yet. Until the list has arrived nobody is treated as new, so someone
  // coming back is never introduced to Vivid again for the blink before their Threads load.
  const isNew = Option.exists(threads, (value) => value.threads.length === 0)
  return isNew ? <Meeting me={me} /> : <Back me={me} />
}

/** Where a new Thread's unsent words are kept for this Person in this workspace. */
const placeOf = (me: MeResponse) =>
  draftPlace(me.person.id, { workspace: workspaceKey(me.workspace), thread: Option.none() })

/** Home for someone Vivid has not met: their first Thread, with Vivid's opening already in it. */
function Meeting({ me }: { me: MeResponse }) {
  /** Starts the Thread that answers the opening, and remembers it as the one that did. */
  const begin = (words: string) => onboarding.began(me.person.id, startThread(words))
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6">
        {/* The same column, gutter and gap as a Thread's messages, so nothing moves when the
            first words turn this into one. */}
        <ol className="mx-auto flex w-full max-w-(--thread-max-w) flex-1 flex-col justify-end gap-5 py-6">
          <Opening me={me} onSay={begin} />
        </ol>
      </div>
      <Composer
        place={placeOf(me)}
        placeholder="What are you waiting on, or want done?"
        working={false}
        onSend={begin}
        onStop={() => undefined}
      />
    </section>
  )
}

/** Home for someone who has written to Vivid before: the greeting and the composer. */
function Back({ me }: { me: MeResponse }) {
  const { name } = useAppearance()
  const over = useSyncExternalStore(onboarding.subscribe, () => onboarding.isOver(me.person.id))
  // Read once: a greeting that changed while someone was looking at it would be a glitch.
  const [hello] = useState(() => greetingAt(new Date().getHours()))
  const first = me.person.name.trim().split(/\s+/u)[0]
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-surface-0">
      <div className="mx-auto flex w-full max-w-(--thread-max-w) flex-1 flex-col justify-center px-2 py-10 sm:px-0">
        <div className="motion-enter px-4 sm:px-6">
          <span className="relative inline-flex">
            <span aria-hidden className="pointer-events-none absolute -inset-10 aura" />
            <Face size={64} mood="happy" className="relative" />
          </span>
          <h1 className="mt-6 font-display text-display font-strong tracking-display text-balance text-ink">
            {first === undefined || first.length === 0 ? `${hello}.` : `${hello}, ${first}.`}
          </h1>
          <p className="mt-2 text-section text-ink-3">
            {Workspace.match(me.workspace, {
              Personal: () => 'What are you waiting on, or want done?',
              Company: ({ company }) => `What are you waiting on at ${company.name}?`,
            })}
          </p>
        </div>

        <div className="mt-6">
          <Composer
            place={placeOf(me)}
            placeholder={`Message ${name}`}
            working={false}
            onSend={(text) => startThread(text)}
            onStop={() => undefined}
          />
        </div>

        {!over && (
          <div className="px-4 sm:px-6">
            <Checklist me={me} />
          </div>
        )}
      </div>
    </section>
  )
}
