import { CircleDashed, CircleCheck, CircleAlert, CircleHelp, ShieldQuestion } from 'lucide-react'
import { cn } from './cn'

export type ConversationStatus = 'ready' | 'working' | 'attention' | 'approve' | 'failed' | 'done'

const STATUS = {
  working: {
    text: 'text-working',
    dot: 'bg-working',
    label: 'Working',
    pulse: true,
    Icon: CircleDashed,
  },
  attention: {
    text: 'text-attention',
    dot: 'bg-attention',
    label: 'Needs you',
    pulse: false,
    Icon: CircleHelp,
  },
  approve: {
    text: 'text-approve',
    dot: 'bg-approve',
    label: 'Approve',
    pulse: false,
    Icon: ShieldQuestion,
  },
  failed: {
    text: 'text-danger',
    dot: 'bg-danger',
    label: 'Failed',
    pulse: false,
    Icon: CircleAlert,
  },
  done: { text: 'text-success', dot: 'bg-success', label: 'Done', pulse: false, Icon: CircleCheck },
} satisfies Record<
  Exclude<ConversationStatus, 'ready'>,
  { text: string; dot: string; label: string; pulse?: boolean; Icon: typeof CircleDashed }
>

/** T3's rule: a status label is shown only when the row is not ready. */
export function StatusLabel({
  status,
  className,
  children,
}: {
  status: ConversationStatus
  className?: string
  children?: React.ReactNode
}) {
  if (status === 'ready') return null
  const s = STATUS[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-meta font-title tabular-nums',
        s.text,
        className,
      )}
    >
      <s.Icon className={cn('size-3.5', s.pulse && 'animate-status-pulse')} />
      {s.label}
      {children}
    </span>
  )
}
