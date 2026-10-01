import { InvitationId, ThreadId, type Notification } from '@vivid/contracts'
import { Option } from 'effect'
import { Bell } from 'lucide-react'
import { change, live, useLiveValue } from '../data/live'
import { Route, router } from '../data/route'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'

const when = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** An invitation notice carries its id at the end of its body; the rest is the sentence. */
const INVITATION = /\s*invitation:(\S+)$/u

/**
 * What happened while the Person was elsewhere: something finished, something needs them, someone
 * shared a Thread or invited them. It floats over the app; choosing a notice goes to what it is
 * about and marks it read on the way.
 */
export function Notifications({ onClose }: { onClose: () => void }) {
  const state = useLiveValue(live.notifications)
  const notices = Option.match(state, { onNone: () => [], onSome: (value) => value.notifications })
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
        aria-label="Notifications"
        className="fixed top-12 left-3 z-50 flex max-h-128 w-88 animate-rise-in flex-col overflow-hidden rounded-panel smooth-shadow-ring-lg glass"
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
            <p className="text-label text-ink-3">Nothing new. Vivid will tell you here.</p>
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
