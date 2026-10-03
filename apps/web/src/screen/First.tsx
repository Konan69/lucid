import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, greetingAt, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { useState, useSyncExternalStore } from 'react'
import { Arrival, arrival } from '../data/arrival'
import { live, LiveState, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'

/**
 * Home: a Thread that does not exist yet. Whatever the Person types becomes one.
 *
 * It is Vivid, a greeting and the composer in the middle of the page, where the eye already is,
 * and nothing else. What is left of getting started is a small control at the foot of the sidebar
 * (`sidebar/Started`), not a block here. There are no suggestion cards: four generic ones used to
 * sit here and were filler.
 *
 * Home draws nothing of Vivid's own. Someone Vivid has not met is not greeted here: the server
 * opens their first Thread and Vivid speaks first in it, for real (`data/arrival`), and they are
 * taken there. Home used to draw an opening and a question itself, which Vivid's model never saw
 * and so asked again in the Thread.
 *
 * Until it is known which of the two this Person is, Home is only Vivid's face (`Waiting`): while
 * the Thread list has not arrived, and while an empty list is having its first Thread opened. The
 * greeting used to show for that moment and then be taken away. If the first Thread cannot be
 * opened, or this Person has Threads somewhere else already, Home is the greeting and the
 * composer and they can simply type.
 */
export function First({ me }: { me: MeResponse }) {
  const threads = useLive(live.threads)
  const route = useSyncExternalStore(router.subscribe, router.route)
  const standing = useSyncExternalStore(arrival.subscribe, arrival.standing)
  const waiting = LiveState.$match(threads, {
    Loading: () => true,
    // A list that could not be read is not a reason to keep someone from typing.
    Failed: () => false,
    // Only on Home itself: this screen also stands behind a device approval, where nothing is
    // asked of the server and so nothing is being waited for.
    Ready: ({ value }) =>
      value.threads.length === 0 && Route.$is('New')(route) && !Arrival.$is('Settled')(standing),
  })
  return waiting ? <Waiting /> : <Back me={me} />
}

/** Home before it is known what to show: Vivid's face alone, as the app is while it loads. */
function Waiting() {
  return (
    <section
      className="flex h-full min-w-0 flex-1 flex-col items-center justify-center bg-surface-0"
      aria-busy
    >
      <Face size={40} mood="thinking" />
    </section>
  )
}

/** Where a new Thread's unsent words are kept for this Person in this workspace. */
const placeOf = (me: MeResponse) =>
  draftPlace(me.person.id, { workspace: workspaceKey(me.workspace), thread: Option.none() })

/** Home as it is once it is known what to show: the greeting and the composer. */
function Back({ me }: { me: MeResponse }) {
  const { name } = useAppearance()
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
      </div>
    </section>
  )
}
