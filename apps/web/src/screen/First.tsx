import type { MeResponse } from '@vivid/contracts'
import { Workspace } from '@vivid/contracts'
import { draftPlace, greetingAt, standingWords, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { ChevronDown } from 'lucide-react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { Arrival, arrival } from '../data/arrival'
import { live, LiveState, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Face, type FaceMood } from '../ui/Face'
import { BAR } from './bar'
import { Composer } from './thread/Composer'

// The card around Vivid is the Thread's own and is fetched when it is first opened, as there.
const AboutHome = lazy(async () => ({ default: (await import('./thread/About')).AboutHome }))

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
      <header className={BAR}>
        <Chip name={name} mood={mood} open={about} onPress={() => setAbout((value) => !value)} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-(--thread-max-w) shrink-0 grow flex-col px-2 py-6 sm:px-0">
          <div className="my-auto">
            <div className="motion-enter px-4 sm:px-6">
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

/**
 * Vivid in Home's bar: its face, the name this Person or their Company gave it, and a chevron
 * because it opens something. One button, and the one face on the page.
 *
 * The face is 28, the size a Thread's bar draws it, and sits on the bar's own leading edge: the
 * pill's fill reaches 4 past it on every side (36 high around a 28 face, so the two curves are
 * concentric) and the pill is pulled back by that 4. A name is at most 24 characters
 * (`VIVID_NAME_MAX`); in a pane too narrow for that it is cut with an ellipsis and the face and
 * chevron keep their size.
 */
function Chip({
  name,
  mood,
  open,
  onPress,
}: {
  name: string
  mood: FaceMood
  open: boolean
  onPress: () => void
}) {
  return (
    // A plain button, not `Button`: no size of that one is a 36-high pill around a face, and its
    // contract is not a screen's to restyle. The fill and its hover are `Button`'s `secondary`.
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onPress}
      className="-ms-1 inline-flex h-9 max-w-full min-w-0 motion-press cursor-pointer items-center gap-2 rounded-full bg-wash-selected ps-1 pe-2.5 text-title font-title whitespace-nowrap text-ink select-none hover:bg-wash-pressed aria-expanded:bg-wash-pressed"
    >
      {/* The name beside it is the button's name; the face must not say it a second time. */}
      <Face size={28} mood={mood} label="" />
      <span className="min-w-0 truncate">{name}</span>
      <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
    </button>
  )
}
