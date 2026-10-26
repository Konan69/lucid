import {
  Workspace,
  type MeResponse,
  type Thread as ThreadRecord,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { splitFull, useSplit } from '../../data/split'
import { useFaceState, useLook } from '../../ui/Alive'
import { cn } from '../../ui/cn'
import { About } from './About'
import { Header, Hero, STANDING } from './Header'
import { Share } from './Share'

/**
 * The Thread's frame: the bar, the conversation and composer, and the card around Vivid with the
 * three things that open it (the bar's list button, its face and title, the hero in the
 * conversation).
 *
 * The conversation stays mounted and warm under the Computer in full view; it is made inert there
 * so focus cannot land on something that is covered. Where the card has room beside a readable
 * column it moves the reading column and composer over together (`around-space`).
 */
export function Layout({
  id,
  me,
  thread,
  arriving,
  present,
  working,
  usingTool,
  failed,
  panelOpen,
  onTogglePanel,
  children,
}: {
  id: ThreadId
  me: MeResponse
  thread: Option.Option<ThreadRecord>
  arriving: Option.Option<string>
  present: ThreadDetail['present']
  working: boolean
  /** Whether Vivid is on a step right now, from the Thread's own stream. Its face shows it. */
  usingTool: boolean
  /** Whether the last thing asked of Vivid here did not work. Its face shows it. */
  failed: boolean
  panelOpen: boolean
  onTogglePanel: () => void
  children: (hero: ReactNode) => ReactNode
}) {
  const [about, setAbout] = useState(false)
  const [sharing, setSharing] = useState(false)
  const full = useSplit(splitFull)
  const attention = working
    ? 'Working'
    : Option.match(thread, { onNone: () => 'Quiet' as const, onSome: (value) => value.attention })
  // The look on Vivid's face is alive: it follows what Vivid is really doing in this Thread and
  // holds, then changes, on the face's own clock (`ui/Alive.tsx`). The words and their colour
  // stay the standing line's.
  const look = useLook(
    useFaceState({
      answering: working,
      usingTool,
      failed,
      needsPerson: attention === 'NeedsYou',
    }),
  )
  // The bar says how Vivid stands (working, waiting for the Person), never which step it is on:
  // that is said in one place, the line at the foot of the conversation (`Doing.tsx`), and the
  // owner asked that the status be said there alone (26 October 2026).
  const standing = { ...STANDING[attention], mood: look }
  return (
    <section
      // `data-alive`: every face in the Thread eases its lean from one look to the next.
      data-alive
      inert={panelOpen && full}
      className="@container/thread relative flex h-full min-w-0 flex-1 flex-col bg-surface-0"
    >
      <Header
        thread={thread}
        arriving={arriving}
        standing={standing}
        about={about}
        onAbout={() => setAbout((value) => !value)}
        present={present}
        me={me}
        panelOpen={panelOpen}
        onShare={() => setSharing(true)}
        onTogglePanel={onTogglePanel}
      />
      <div className={cn('flex min-h-0 flex-1 flex-col', about && 'around-space')}>
        {children(!about && <Hero mood={standing.mood} onOpen={() => setAbout(true)} />)}
      </div>
      {about && (
        <About
          thread={id}
          mood={standing.mood}
          standing={standing.words}
          onClose={() => setAbout(false)}
          onOpenComputer={() => {
            if (!panelOpen) onTogglePanel()
          }}
        />
      )}
      {sharing && Option.isSome(thread) && Workspace.guards.Company(me.workspace) && (
        <Share
          thread={thread.value}
          company={me.workspace.company.name}
          me={me.person.id}
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  )
}
