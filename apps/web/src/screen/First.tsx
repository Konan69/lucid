import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, greetingAt, standingWords, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { lazy, Suspense, useState } from 'react'
import { Arrival, useArrival } from '../data/arrival'
import { live, LiveState, useLive } from '../data/live'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'
import { HeroButton } from './thread/Header'

// The card around Vivid is the Thread's own and is fetched when it is first opened, as there.
const AboutHome = lazy(() =>
  import('./thread/About').then((module) => ({ default: module.AboutHome })),
)

/**
 * Home: a Thread that does not exist yet. Whatever the Person types becomes one.
 *
 * It is a greeting and the composer in the middle of the page, where the eye already is, and
 * Vivid itself in the bar above them: its face and name as one chip at the leading edge, where a
 * Thread's bar has its face, so going from Home into a Thread does not move it. The chip opens the
 * card around Vivid (`thread/About`), which is where its computers are. What is left of getting started is a small control at the foot of the sidebar
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
  const standing = useArrival((state) => state.standing)
  const waiting = LiveState.$match(threads, {
    Loading: () => true,
    // A list that could not be read is not a reason to keep someone from typing.
    Failed: () => false,
    // This screen is drawn only at `/` (`routes/first.tsx`), which is where the first arrival is
    // asked for (`data/arrival`), so an empty list here is always one being waited on.
    Ready: ({ value }) => value.threads.length === 0 && !Arrival.$is('Settled')(standing),
  })
  // Vivid is at work somewhere when any Thread in the list says so. A first message sent from
  // here is not counted: `startThread` goes to the new Thread at once, so Home is never on screen
  // while it is being sent.
  const working =
    LiveState.$is('Ready')(threads) &&
    threads.value.threads.some((thread) => thread.attention === 'Working')
  return waiting ? <Waiting /> : <Back me={me} working={working} />
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

/**
 * Home as it is once it is known what to show: Vivid in the bar, and the greeting and the composer
 * as one group in the middle of everything under the bar.
 *
 * The middle is the true one, as T3 Code centres an empty new thread
 * (`apps/web/src/components/ChatView.tsx`, the `isDraftHeroState` composer overlay): it is taken
 * from this pane alone, so nothing beside it moves it. T3 Code centres with an absolute overlay,
 * which cuts the top off when the window is shorter than the group. Here the group is centred by
 * its own `margin-block: auto` inside a column that is at least as tall as the scrolling area:
 * with room to spare the two margins share it equally, and with none they are zero, so the group
 * starts 24 under the bar and the page scrolls. `justify-center` would push it up past the top of
 * the scroll, where it cannot be reached.
 */
function Back({ me, working }: { me: MeResponse; working: boolean }) {
  const { name } = useAppearance()
  // Read once: a greeting that changed while someone was looking at it would be a glitch.
  const [hello] = useState(() => greetingAt(new Date().getHours()))
  const [about, setAbout] = useState(false)
  const first = me.person.name.trim().split(/\s+/u)[0]
  const mood = working ? 'thinking' : 'happy'
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      {/* Vivid sits where a Thread puts it: the face at 56 with its name capsule under it, at
          the top centre (`HeroButton`, the same piece a conversation starts with). */}
      <header className="flex shrink-0 justify-center pt-4">
        <HeroButton mood={mood} open={about} onOpen={() => setAbout((value) => !value)} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-(--thread-max-w) shrink-0 grow flex-col px-2 py-6 sm:px-0">
          <div className="my-auto">
            <div className="motion-enter px-4 text-center sm:px-6">
              <h1 className="font-display text-display font-strong tracking-display text-balance wrap-break-word text-ink">
                {first === undefined || first.length === 0 ? `${hello}.` : `${hello}, ${first}.`}
              </h1>
              <p className="mt-2 text-section text-pretty wrap-break-word text-ink-3">
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
        </div>
      </div>
      {about && (
        <Suspense fallback={null}>
          <AboutHome
            mood={mood}
            standing={working ? standingWords.Working : standingWords.Quiet}
            onClose={() => setAbout(false)}
          />
        </Suspense>
      )}
    </section>
  )
}
