import { BadgeCheck, Mail, MessageSquare, PhoneOutgoing } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import type { CallSession, Entry } from '../call/session'
import type { Work } from '../call/script'
import { cn } from '../ui/cn'

/**
 * What Vivid does while you talk, appearing in the Thread line by line as it says each one.
 * Each card is a mark, a title and one quiet line under it — the shape a message, a sent mail or
 * a placed call already has elsewhere in the product, so the record reads like the Thread and
 * not like a debug log.
 */

/** A work card: a mark tile, the thing that happened, and the detail under it. */
function Card({ mark, title, detail }: { mark: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex animate-fade-in items-center gap-3 rounded-card bg-surface-2 p-2.5 pr-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-0 text-ink-2 smooth-shadow-ring-xs">
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label font-title text-ink">{title}</span>
        <span className="block truncate text-label text-ink-3">{detail}</span>
      </span>
    </div>
  )
}

/** Each kind of work gets the mark and wording it would carry anywhere else in Vivid. */
function WorkCard({ work }: { work: Work }) {
  switch (work.kind) {
    case 'message':
      return (
        <Card mark={<MessageSquare className="size-5" />} title={work.from} detail={work.text} />
      )
    case 'email':
      return (
        <Card
          mark={<Mail className="size-5" />}
          title={work.subject}
          detail={`Sent to ${work.to} · ${work.when}`}
        />
      )
    case 'approval':
      return (
        <Card
          mark={<BadgeCheck className="size-5 text-success" />}
          title={`${work.by} approved ${work.what}`}
          detail="No changes requested"
        />
      )
    case 'calling':
      return (
        <Card
          mark={<PhoneOutgoing className="size-5 text-accent" />}
          title={`Calling ${work.who}`}
          detail={work.about}
        />
      )
  }
}

/** The log as the Thread shows it: Vivid's work, newest last, in one quiet column. */
export function Worklog({ session }: { session: CallSession }) {
  const log: readonly Entry[] = useSyncExternalStore(session.subscribe, session.getLog)
  if (log.length === 0) return null
  return (
    <ul className={cn('flex flex-col gap-2', 'max-w-100')}>
      {log.map((entry) => (
        <li key={entry.id}>
          <WorkCard work={entry.work} />
        </li>
      ))}
    </ul>
  )
}
