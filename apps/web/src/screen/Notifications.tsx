import type { Approval, Notification, NotificationId } from '@vivid/contracts'
import {
  allowing,
  everyNoticeRead,
  invitationIn,
  noticeFace,
  noticeRows,
  NoticeRow,
  noticesRead,
  type NoticeFace,
} from '@vivid/state'
import { Option } from 'effect'
import { Bell, Check, Hand, Newspaper, Share2, UserPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useApprovalDecision } from '../data/approvals'
import { change, live, LiveState, useLive, useLiveValue } from '../data/live'
import { router } from '../router'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Emblem, type Hue } from './Emblem'
import { Decide } from './feed/Decide'
import { PRESS } from './motion'

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** Counts are written the way the Person's own locale writes them: "1,000", not "1000". */
const count = new Intl.NumberFormat()

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
 * for an invitation, cyan for something on the Feed. A new kind of notice fails to compile here.
 */
const KIND = {
  finished: { hue: 'green', icon: <Check /> },
  'needs-you': { hue: 'orange', icon: <Hand /> },
  shared: { hue: 'blue', icon: <Share2 /> },
  invited: { hue: 'violet', icon: <UserPlus /> },
  posted: { hue: 'cyan', icon: <Newspaper /> },
} as const satisfies Record<Notification['kind'], { hue: Hue; icon: ReactNode }>

/**
 * What the empty panel says. "Nothing new" is an answer, so it is only said once the server has
 * answered: before that it is still looking, and when it cannot be reached it says that instead.
 */
const QUIET = {
  Loading: 'Looking…',
  Failed: 'Vivid can’t reach your notifications right now.',
  Ready: 'You’re all caught up. New notifications from Vivid appear here.',
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

/** Shows these notices as read at once, sends that, and takes it back if the server refuses. */
function read(ids: ReadonlyArray<NotificationId>) {
  // Nothing unread is nothing to send; a request with no ids would also not mean "none".
  if (ids.length === 0) return
  const at = Date.now()
  void change(
    (client) => client.ReadNotifications({ ids }),
    () => live.notifications.expect(noticesRead(ids, at)),
  )
}

/** Marks every notice read, shown at once the same way. */
function readAll() {
  const at = Date.now()
  void change(
    (client) => client.ReadNotifications({}),
    () => live.notifications.expect(everyNoticeRead(at)),
  )
}

/**
 * Goes to what a row is about and marks all of it read on the way. A Thread's row opens the
 * Thread, where every one of its questions is answered, so one press reads every notice about
 * it in one request. A notice about no Thread opens its invitation when it carries one.
 */
const visit = NoticeRow.$match({
  Single: ({ notice }) => {
    if (notice.readAt === null) read([notice.id])
    const invitation = invitationIn(notice)
    if (Option.isSome(invitation))
      void router.navigate({ to: '/invite/$id', params: { id: invitation.value } })
  },
  Grouped: ({ threadId, unread }) => {
    read(unread)
    void router.navigate({ to: '/t/$id', params: { id: threadId } })
  },
})

/**
 * The open panel: the count, the way to clear it, and a row for each place to go, newest first.
 */
function Panel({ onClose }: { onClose: () => void }) {
  const state = useLive(live.notifications)
  const threads = useLiveValue(live.threads)
  // "3h" is counted from the moment the panel opened, read once: a render must not read the clock.
  const [opened] = useState(() => Date.now())
  const notices = LiveState.$is('Ready')(state) ? state.value.notifications : []
  const rows = noticeRows(
    notices,
    // Until the Thread list has answered, a row leads with its notice's own title.
    Option.match(threads, { onNone: () => [], onSome: (list) => list.threads }),
  )
  const unread = notices.filter((notice) => notice.readAt === null).length
  // What waits on the Person's yes, decided here (#129). One decided here never waits again, so it
  // leaves at once rather than when the inbox next answers.
  const inbox = useLiveValue(live.inbox)
  const deciding = useApprovalDecision()
  const asks = Option.match(inbox, {
    onNone: () => [],
    onSome: (held) => held.approvals.filter((approval) => !allowing.sentOn(deciding, approval.id)),
  })
  const titleOf = (approval: Approval) =>
    Option.match(threads, {
      onNone: () => Option.none<string>(),
      onSome: (list) =>
        Option.fromUndefinedOr(list.threads.find((thread) => thread.id === approval.threadId)).pipe(
          Option.map((thread) => thread.title.trim()),
          Option.filter((title) => title !== ''),
        ),
    })

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 px-3 hairline-b">
        <h2 className="text-label font-title text-ink">Notifications</h2>
        {unread > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-meta font-title text-primary-foreground tabular-nums">
            {count.format(unread)}
          </span>
        )}
        <span className="flex-1" />
        {unread > 0 && (
          <Button size="sm" variant="ghost" onClick={readAll}>
            Mark all read
          </Button>
        )}
      </header>
      {rows.length === 0 && asks.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <Emblem hue="gray" size={36}>
            <Bell />
          </Emblem>
          <p className="max-w-56 text-label text-pretty text-ink-3" aria-live="polite">
            {QUIET[state._tag]}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {asks.length > 0 && (
            <section aria-labelledby="waiting-on-you" className="px-3 pt-2.5 pb-1 hairline-b">
              <h3 id="waiting-on-you" className="text-meta font-title text-ink-3">
                Waiting on you
              </h3>
              <ul className="flex flex-col">
                {asks.map((approval) => (
                  <li key={approval.id} className="py-2.5 not-first:hairline-t">
                    <Asked
                      approval={approval}
                      title={titleOf(approval)}
                      onOpen={() => {
                        onClose()
                        void router.navigate({ to: '/t/$id', params: { id: approval.threadId } })
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ul className="p-1">
            {rows.map((row) => {
              const face = noticeFace(row)
              return (
                <li key={face.key}>
                  <Row
                    face={face}
                    now={opened}
                    onOpen={() => {
                      onClose()
                      visit(row)
                    }}
                  />
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </>
  )
}

/**
 * One Approval waiting on the Person, decided in the panel: where it was asked (its Thread's
 * title, which opens the Thread), then the Approval itself (`Decide`), a send as its draft.
 */
function Asked({
  approval,
  title,
  onOpen,
}: {
  approval: Approval
  /** The Thread's title; absent until the Thread list answers, or while it has none. */
  title: Option.Option<string>
  onOpen: () => void
}) {
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-row text-meta font-meta text-ink-3 hover:text-ink-2 hover:underline"
      >
        <Hand aria-hidden className="size-3.5 shrink-0 text-attention" />
        <span className="min-w-0 truncate">
          <bdi>{Option.getOrElse(title, () => 'Open its Thread')}</bdi>
        </span>
      </button>
      <Decide approval={approval} room="panel" />
    </>
  )
}

/**
 * One row: the newest notice's mark, where it leads (a Thread's title), and under it one line of
 * what was last said, with what is unread at the trailing edge.
 *
 * The mark, the title and the time are on the same three edges in every row, so the time is
 * alone at the end of the first line and nothing after it moves it: the unread dot and the count
 * sit under it, at the end of the second line. That line is the one that gives way. A long title
 * keeps its room beside "Yesterday, 11:42 PM", which a count on the first line took from it, and
 * the count is never cut short. Both lines are one line each, so every row is the same height
 * and a count that changes while the panel is open changes words, not layout.
 *
 * An unread row is said in the title weight; a read one steps back to the quieter ink, so what
 * is new is found without reading. Several unread notices are one dot and "3 new", never three
 * dots. Titles and bodies are other people's words in any script, so each is isolated with
 * `bdi`: a right-to-left title reads correctly and still starts at the title edge.
 */
function Row({
  face,
  now,
  onOpen,
}: {
  face: NoticeFace
  /** The moment "3h ago" is counted from. */
  now: number
  onOpen: () => void
}) {
  const unread = face.unread > 0
  const kind = KIND[face.notice.kind]
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer gap-3 rounded-row p-2.5 text-start hover:bg-wash-hover',
        PRESS,
      )}
    >
      <Emblem hue={kind.hue} size={28} className={cn('mt-0.5', !unread && 'opacity-60')}>
        {kind.icon}
      </Emblem>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {/* The whole title is one press away in the Thread; until then a hover shows it. */}
          <span
            title={face.heading}
            className={cn(
              'min-w-0 flex-1 truncate text-label',
              unread ? 'font-title text-ink' : 'text-ink-2',
            )}
          >
            <bdi>{face.heading}</bdi>
          </span>
          <time className="shrink-0 text-meta font-meta text-ink-3 tabular-nums">
            {ago(face.notice.createdAt, now)}
          </time>
        </span>
        <span className="flex items-baseline gap-2 text-label text-ink-3">
          {Option.isSome(face.spoken) && <span className="sr-only">{face.spoken.value}</span>}
          {face.waiting && <span className="shrink-0 text-attention">Needs you</span>}
          <span className="min-w-0 flex-1 truncate">
            <bdi>{face.line}</bdi>
          </span>
          {face.unread > 1 && (
            <span className="shrink-0 text-meta font-meta text-ink-2 tabular-nums">
              {count.format(face.unread)} new
            </span>
          )}
          {unread && (
            <i
              role="img"
              aria-label="Unread"
              className="size-1.5 shrink-0 self-center rounded-full bg-primary"
            />
          )}
        </span>
      </span>
    </button>
  )
}
