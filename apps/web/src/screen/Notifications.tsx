import { InvitationId, ThreadId, type Notification } from '@vivid/contracts'
import { Bell } from 'lucide-react'
import { change, live, LiveState, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { holdFocus } from '../ui/Layer'

const when = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** An invitation notice carries its id at the end of its body; the rest is the sentence. */
const INVITATION = /\s*invitation:(\S+)$/u

/**
 * What the empty panel says. "Nothing new" is an answer, so it is only said once the server has
 * answered: before that it is still looking, and when it cannot be reached it says that instead.
 */
const QUIET = {
  Loading: 'Looking…',
  Failed: 'Vivid can’t reach your notifications right now.',
  Ready: 'Nothing new. Vivid will tell you here.',
} satisfies Record<LiveState<unknown>['_tag'], string>

/**
 * What happened while the Person was elsewhere: something finished, something needs them, someone
 * shared a Thread or invited them. It floats over the app; choosing a notice goes to what it is
 * about and marks it read on the way.
 */
export function Notifications({ onClose }: { onClose: () => void }) {
  const state = useLive(live.notifications)
  const notices = LiveState.$is('Ready')(state) ? state.value.notifications : []
  const unread = notices.some((notice) => notice.readAt === null)

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
      <button
        type="button"
        aria-label="Close notifications"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <section
        ref={holdFocus}
        aria-label="Notifications"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        // It opens from the bell, so it grows from the corner nearest the bell, quickly.
        className="fixed inset-x-3 top-12 z-50 flex max-h-128 origin-top-left flex-col overflow-hidden rounded-panel lift glass transition-pop duration-(--dur-fast) ease-out outline-none sm:right-auto sm:w-88 starting:scale-97 starting:opacity-0"
      >
        <header className="flex h-11 shrink-0 items-center gap-2 px-3 hairline-b">
          <h2 className="flex-1 text-label font-title text-ink">Notifications</h2>
          {unread && (
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
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Bell className="size-5 text-ink-4" />
            <p className="text-label text-ink-3" aria-live="polite">
              {QUIET[state._tag]}
            </p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {notices.map((notice) => (
              <li key={notice.id}>
                <button
                  onClick={() => open(notice)}
                  className="flex w-full cursor-pointer gap-2.5 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
                >
                  <i
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      notice.readAt === null ? 'bg-accent' : 'bg-transparent',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label font-title text-ink">
                      {notice.title}
                    </span>
                    <span className="line-clamp-2 text-label text-ink-3">
                      {notice.body.replace(INVITATION, '')}
                    </span>
                    <span className="mt-0.5 block text-meta font-meta text-ink-3">
                      {when.format(notice.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
