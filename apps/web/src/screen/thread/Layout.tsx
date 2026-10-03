import {
  Workspace,
  type MeResponse,
  type Thread as ThreadRecord,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { Option } from 'effect'
import { lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from 'react'
import { split } from '../../data/split'
import { cn } from '../../ui/cn'
import { Header, Hero, STANDING } from './Header'
import { Share } from './Share'

const About = lazy(async () => ({ default: (await import('./About')).About }))

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
  panelOpen: boolean
  onTogglePanel: () => void
  children: (hero: ReactNode) => ReactNode
}) {
  const [about, setAbout] = useState(false)
  const [sharing, setSharing] = useState(false)
  const full = useSyncExternalStore(split.subscribe, split.isFull)
  const attention = working
    ? 'Working'
    : Option.match(thread, { onNone: () => 'Quiet' as const, onSome: (value) => value.attention })
  const standing = STANDING[attention]
  return (
    <section
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
        <Suspense fallback={null}>
          <About
            thread={id}
            mood={standing.mood}
            standing={standing.words}
            onClose={() => setAbout(false)}
            onOpenComputer={() => {
              if (!panelOpen) onTogglePanel()
            }}
          />
        </Suspense>
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
