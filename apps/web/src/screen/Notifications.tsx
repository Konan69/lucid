import { InvitationId, ThreadId, type Notification } from '@vivid/contracts'
import { Bell, Check, Hand, Share2, UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Emblem, type Hue } from './Emblem'
import { PRESS } from './motion'

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The start of the day a moment falls in, in the browser's own zone. */
const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0)

/**
 * How long ago a notice arrived, the way a person would say it: "Now", "12m", "3h" within the
 * day, then "Yesterday" and the time, then the date. A notice is glanced at, so the recent ones
 * are counted and only the old ones are dated.
 */
function ago(at: number, now: number): string {
  const passed = now - at
  if (passed < MINUTE) return 'Now'
  if (passed < HOUR) return `${Math.floor(passed / MINUTE)}m`
  if (dayOf(at) === dayOf(now)) return `${Math.floor(passed / HOUR)}h`
  if (dayOf(now) - dayOf(at) <= 24 * HOUR) return `Yesterday, ${clock.format(at)}`
  return monthDay.format(at)
}

/**
 * The mark each kind of notice leads with, so the panel can be read by colour before a word of
 * it is: green for done, amber-orange for "this needs you", blue for something shared, violet
 * for an invitation. A new kind of notice fails to compile here.
 */
const KIND = {
  finished: { hue: 'green', icon: <Check /> },
  'needs-you': { hue: 'orange', icon: <Hand /> },
  shared: { hue: 'blue', icon: <Share2 /> },
  invited: { hue: 'violet', icon: <UserPlus /> },
} as const satisfies Record<Notification['kind'], { hue: Hue; icon: ReactNode }>

/** An invitation notice carries its id at the end of its body; the rest is the sentence. */
const INVITATION = /\s*invitation:(\S+)$/u

/**
 * What the empty panel says. "Nothing new" is an answer, so it is only said once the server has
 * answered: before that it is still looking, and when it cannot be reached it says that instead.
 */
const QUIET = {
  Loading: 'Looking…',
  Failed: 'Vivid can’t reach your notifications right now.',
  Ready: 'You’re all caught up. Vivid will tell you here.',
} satisfies Record<LiveState<unknown>['_tag'], string>

/**
 * The bell, and what it opens: what happened while the Person was elsewhere. Something finished,
 * something needs them, someone shared a Thread or invited them.
 *
 * It is shadcn's `Popover` hung from the bell, so it grows from the bell, Escape or a click
 * anywhere else closes it, and the keyboard goes back to the bell. The panel is drawn only while
 * it is open, so nothing is counted or formatted for a closed one.
 */
export function Notifications({ unread }: { unread: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* `relative` places the unread dot on the bell's own corner. */}
      <PopoverTrigger render={<IconButton label="Notifications" className="relative" />}>
        <Bell className="size-4" />
        {unread > 0 && (
          <i className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-surface-1" />
        )}
      </PopoverTrigger>
      {/* The bell is at the sidebar's right edge and the panel is wider than the sidebar, so it
          is aligned to the bell's right and kept 12 px inside the window: it lands over the
          sidebar on a wide window and fills the width of a phone. */}
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        flush
        aria-label="Notifications"
        className="max-h-128 w-88 max-w-(--available-width)"
      >
        <Panel onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The open panel: the count, the way to clear it, and the notices, newest first. */
function Panel({ onClose }: { onClose: () => void }) {
  const state = useLive(live.notifications)
  const notices = LiveState.$is('Ready')(state) ? state.value.notifications : []
  const unread = notices.filter((notice) => notice.readAt === null).length
  // "3h" is counted from the moment the panel opened, read once: a render must not read the clock.
  const [opened] = useState(() => Date.now())

  /** Goes to what a notice is about, and marks it read on the way. */
  function open(notice: Notification) {
    void change((client) => client.ReadNotifications({ ids: [notice.id] }))
    onClose()
    const invitation = INVITATION.exec(notice.body)
    if (invitation !== null && invitation[1] !== undefined) {
      router.go(Route.Invite({ id: InvitationId.make(invitation[1]) }))
      return
    }
    if (notice.threadId !== null) router.go(Route.Thread({ id: ThreadId.make(notice.threadId) }))
  }

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 px-3 hairline-b">
        <h2 className="text-label font-title text-ink">Notifications</h2>
        {unread > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-meta font-title text-primary-foreground tabular-nums">
            {unread}
          </span>
        )}
        <span className="flex-1" />
        {unread > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void change((client) => client.ReadNotifications({}))}
          >
            Mark all read
          </Button>
        )}
      </header>
      {notices.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <Emblem hue="gray" size={36}>
            <Bell />
          </Emblem>
          <p className="max-w-56 text-label text-pretty text-ink-3" aria-live="polite">
            {QUIET[state._tag]}
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {notices.map((notice) => (
            <li key={notice.id}>
              <Notice notice={notice} now={opened} onOpen={() => open(notice)} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * One notice: its kind's mark, what happened, and how long ago. An unread one is said in the
 * title weight with the accent dot after its time; a read one steps back to the quieter ink, so
 * what is new is found without reading.
 */
function Notice({
  notice,
  now,
  onOpen,
}: {
  notice: Notification
  /** The moment "3h ago" is counted from. */
  now: number
  onOpen: () => void
}) {
  const unread = notice.readAt === null
  const kind = KIND[notice.kind]
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer gap-3 rounded-row p-2.5 text-left hover:bg-wash-hover',
        PRESS,
      )}
    >
      <Emblem hue={kind.hue} size={28} className={cn('mt-0.5', !unread && 'opacity-60')}>
        {kind.icon}
      </Emblem>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-label',
              unread ? 'font-title text-ink' : 'text-ink-2',
            )}
          >
            {notice.title}
          </span>
          <time className="shrink-0 text-meta font-meta text-ink-3 tabular-nums">
            {ago(notice.createdAt, now)}
          </time>
          {unread && (
            <i
              aria-label="Unread"
              className="size-1.5 shrink-0 self-center rounded-full bg-primary"
            />
          )}
        </span>
        <span className="line-clamp-2 text-label text-pretty text-ink-3">
          {notice.body.replace(INVITATION, '')}
        </span>
      </span>
    </button>
  )
}
