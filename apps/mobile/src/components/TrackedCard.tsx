import * as Schema from 'effect/Schema'
import { View } from 'react-native'
import { Check } from 'lucide-react-native'
import { useTheme } from '../theme'
import { Card, Label } from './ui'

const TrackedOutputSchema = Schema.Struct({
  task: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      assignee: Schema.optional(Schema.String),
      dueAt: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    }),
  ),
  followUp: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
        repeatEveryMs: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
})

// The same tracked-work card and copy as web/src/screen/Conversation.tsx.
export function TrackedCard({ kind, output }: { kind: string; output: unknown }) {
  const { colors: c } = useTheme()
  if (kind !== 'create_task' && kind !== 'schedule_follow_up') return null
  const decoded = Schema.decodeUnknownOption(TrackedOutputSchema)(output)
  if (decoded._tag === 'None') return null
  const result = decoded.value
  const task = result.task
  if (task === undefined) return null
  const when = (value?: string | number | null) => {
    if (value == null) return ''
    const date = new Date(value)
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : ''
  }
  const due = when(task.dueAt)
  const followUp = result.followUp
  const followUpAt = followUp === null || followUp === undefined ? undefined : followUp.at
  const followUpRepeat =
    followUp === null || followUp === undefined ? false : !!followUp.repeatEveryMs
  const followUpTime = when(followUpAt)
  const meta = [
    task.assignee && task.assignee !== 'you' ? `Waiting on ${task.assignee}` : '',
    due ? `Due ${due}` : '',
    followUpTime ? `${followUpRepeat ? 'Follows up from' : 'Follows up'} ${followUpTime}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Card
      style={{
        marginTop: 12,
        flexDirection: 'row',
        gap: 12,
        backgroundColor: c['surface-2'],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c['accent-soft'],
        }}
      >
        <Check size={16} color={c['accent-ink']} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Label size="micro" tone="ink-4">
          {kind === 'create_task' ? 'Vivid is tracking this' : 'Vivid will follow up'}
        </Label>
        <Label size="label">{task.title}</Label>
        {!!meta && (
          <Label size="micro" tone="ink-3">
            {meta}
          </Label>
        )}
      </View>
    </Card>
  )
}
