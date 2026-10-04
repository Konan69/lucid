import {
  ThreadAudience,
  Workspace,
  type MeResponse,
  type Thread as ThreadRecord,
  type ThreadDetail,
} from '@vivid/contracts'
import { standingWords } from '@vivid/state'
import { Option } from 'effect'
import { ChevronDown, ListTree, Lock, MonitorSmartphone, Share2, Users } from 'lucide-react'
import { Faces } from '../../ui/Person'
import { Button, IconButton } from '../../ui/button'
import { useAppearance } from '../../data/vivid'
import { cn } from '../../ui/cn'
import { Face, type FaceMood } from '../../ui/Face'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { BAR } from '../bar'

/**
 * How Vivid is doing in a Thread: the line under its title (the same words on every surface),
 * and here the look on its face and the colour the line is set in.
 */
export const STANDING = {
  Working: { words: standingWords.Working, mood: 'thinking', tone: 'text-working' },
  NeedsYou: { words: standingWords.NeedsYou, mood: 'neutral', tone: 'text-attention' },
  Unread: { words: standingWords.Unread, mood: 'happy', tone: 'text-ink-3' },
  Quiet: { words: standingWords.Quiet, mood: 'neutral', tone: 'text-ink-3' },
} as const satisfies Record<
  ThreadRecord['attention'],
  { words: string; mood: FaceMood; tone: string }
>

/** How Vivid stands in a Thread's bar: the words, the look on its face, the colour of the line. */
export interface Standing {
  readonly words: string
  readonly mood: FaceMood
  readonly tone: string
}

/**
 * The top of a Thread. Vivid is in it, not just named by it: its face, the Thread's title, and a
 * line saying how it is doing right now (here, working, waiting for the Person). On the right,
 * who else is here, who can see the Thread, everything around Vivid, and its computer.
 */
export function Header({
  thread,
  arriving,
  standing,
  about,
  onAbout,
  present,
  me,
  panelOpen,
  onShare,
  onTogglePanel,
}: {
  thread: Option.Option<ThreadRecord>
  /** What a Thread still on its way to the server will be called: its first words. */
  arriving: Option.Option<string>
  standing: Standing
  about: boolean
  onAbout: () => void
  present: ThreadDetail['present']
  me: MeResponse
  panelOpen: boolean
  onShare: () => void
  onTogglePanel: () => void
}) {
  const others = present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  const inCompany = Workspace.guards.Company(me.workspace)
  const mine = Option.exists(thread, (value) => value.createdBy.id === me.person.id)
  const title = Option.match(thread, {
    onNone: () => Option.getOrElse(arriving, () => 'New thread'),
    onSome: (value) => value.title,
  })
  return (
    <header className={cn(BAR, 'gap-3')}>
      {/* Vivid's face and the title are one button: it opens the card around Vivid, the same one
          the list button and the hero open. The title is its name, so it is not repeated. */}
      <h1 className="min-w-0 flex-1">
        <button
          aria-haspopup="dialog"
          aria-expanded={about}
          onClick={onAbout}
          className="-mx-1.5 flex max-w-full min-w-0 cursor-pointer items-center gap-3 rounded-control px-1.5 py-1 text-left transition-press duration-(--dur-fast) hover:bg-wash-hover focus-visible:bg-wash-hover active:scale-98"
        >
          <Face size={28} mood={standing.mood} />
          <span className="min-w-0">
            <span className="block truncate text-title font-title text-ink">{title}</span>
            <span
              className={cn('block truncate text-meta font-meta', standing.tone)}
              aria-live="polite"
            >
              {typing.length > 0
                ? `${typing.map((seen) => seen.person.name).join(', ')} typing…`
                : standing.words}
            </span>
          </span>
        </button>
      </h1>
      {others.length > 0 && <Faces people={others.map((seen) => seen.person)} size={20} />}
      {Option.isSome(thread) && inCompany && (
        // The tooltip's trigger is a span around the button, not the button: a disabled button
        // answers no pointer in some browsers, and "Only its creator can change this" is the
        // sentence a Person who cannot press it needs to read.
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button variant="ghost" size="sm" disabled={!mine} onClick={onShare}>
              <AudienceIcon audience={thread.value.audience} />
              {ThreadAudience.match(thread.value.audience, {
                Private: () => 'Share',
                People: ({ participants }) => `${participants.length + 1} people`,
                Company: () => 'Everyone',
              })}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {mine ? 'Choose who can see this thread' : 'Only its creator can change this'}
          </TooltipContent>
        </Tooltip>
      )}
      <IconButton
        label="Around Vivid"
        active={about}
        aria-haspopup="dialog"
        aria-expanded={about}
        onClick={onAbout}
      >
        <ListTree className="size-4" />
      </IconButton>
      <IconButton label="Vivid’s computer" active={panelOpen} onClick={onTogglePanel}>
        <MonitorSmartphone className="size-4" />
      </IconButton>
    </header>
  )
}

/** Private and shared audiences keep their existing permission controls. */
function AudienceIcon({ audience }: { audience: ThreadAudience }) {
  if (ThreadAudience.guards.Private(audience)) return <Share2 className="size-3.5" />
  return ThreadAudience.guards.People(audience) ? (
    <Users className="size-3.5" />
  ) : (
    <Lock className="hidden" />
  )
}

/**
 * Vivid at the top of the conversation: its face at 56 and its name in a small capsule with a
 * chevron, which says it opens something. It is part of the conversation's scroll, so it leaves
 * with the first messages, and while the card around Vivid is open the card owns the identity.
 */
export function Hero({ mood, onOpen }: { mood: FaceMood; onOpen: () => void }) {
  // The name this Person or their Company gave Vivid, live.
  const { name } = useAppearance()
  return (
    <li className="pt-4 pb-8 text-center">
      <button
        aria-haspopup="dialog"
        aria-expanded={false}
        onClick={onOpen}
        className="group/hero inline-flex cursor-pointer flex-col items-center gap-2 rounded-panel transition-press duration-(--dur-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-96"
      >
        <Face size={56} mood={mood} />
        <span className="flex h-6 items-center gap-0.5 rounded-full pr-1.5 pl-2.5 text-title text-ink-2 ring-line transition-press duration-(--dur-fast) group-hover/hero:bg-wash-hover group-hover/hero:text-ink group-focus-visible/hero:bg-wash-hover">
          {name}
          <ChevronDown className="size-3.5 text-ink-3" />
        </span>
      </button>
    </li>
  )
}
