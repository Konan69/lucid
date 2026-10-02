import type { FlueConversationMessage } from '@flue/react'
import type { Approval, InputRequest, PersonId, Run } from '@vivid/contracts'
import { speakerOfTurn } from '@vivid/state'
import { Option, Schema } from 'effect'
import { AlarmClock, Check, ChevronRight, Repeat2 } from 'lucide-react'
import { useState } from 'react'
import { describeToolCall } from '../../data/activity'
import { Avatar } from '../../ui/Avatar'
import { cn } from '../../ui/cn'
import { Face } from '../../ui/Face'
import { Markdown } from '../../ui/Markdown'
import {
  ApprovalCard,
  approvalById,
  cardFor,
  ConnectionCard,
  InputCard,
  requestById,
} from './Cards'

type ToolPart = Extract<FlueConversationMessage['parts'][number], { type: 'dynamic-tool' }>

const Metadata = Schema.Struct({
  finishedAt: Schema.optionalKey(Schema.Number),
  startedAt: Schema.optionalKey(Schema.Number),
})
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

const Tracked = Schema.Struct({
  task: Schema.Struct({
    title: Schema.String,
    assignee: Schema.optionalKey(Schema.String),
    dueAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
})
const decodeTracked = Schema.decodeUnknownOption(Tracked)

/** What the Thread carries beside its messages, which the cards and attributions are drawn from. */
export interface ThreadContext {
  readonly me: PersonId
  readonly shared: boolean
  readonly runs: ReadonlyArray<Run>
  readonly approvals: ReadonlyArray<Approval>
  readonly requests: ReadonlyArray<InputRequest>
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** When a message was finished, when Vivid said so; an unstamped message simply shows no time. */
function timeOf(message: FlueConversationMessage) {
  return Option.flatMap(decodeMetadata(message.metadata), (metadata) =>
    Option.map(
      Option.orElse(Option.fromUndefinedOr(metadata.finishedAt), () =>
        Option.fromUndefinedOr(metadata.startedAt),
      ),
      (moment) => clock.format(moment),
    ),
  )
}

/** A message's words, without what Vivid did or asked beside them. */
export const textOf = (message: FlueConversationMessage) =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')

/**
 * A Vivid message with nothing a Person can read in it: no words, no step, no card. The runtime
 * writes one when a model call ends without producing anything. The Run's own state says what
 * happened and is drawn in its place, so the empty shell (a face and a time beside nothing) is not.
 */
export const isBlank = (message: FlueConversationMessage) =>
  message.role === 'assistant' &&
  textOf(message).trim().length === 0 &&
  !message.parts.some((part) => part.type === 'dynamic-tool')

/**
 * One message in a Thread, drawn by who it is from. A Person's words are a bubble (theirs on the
 * right, anyone else's on the left with a face and a name); Vivid's are text with whatever it did
 * and whatever it is asking; a signal that woke Vivid is a quiet line saying why.
 */
export function Message({
  message,
  context,
  working,
  onContinue,
}: {
  message: FlueConversationMessage
  context: ThreadContext
  working: boolean
  onContinue: (text: string) => void
}) {
  if (message.role === 'user') return <Said text={textOf(message)} mine />
  if (message.role === 'system') return <Signal message={message} context={context} />
  return <FromVivid message={message} context={context} working={working} onContinue={onContinue} />
}

/** A Person's words. In a shared Thread everyone else's carry their name and face. */
export function Said({
  text,
  mine,
  from,
}: {
  text: string
  mine: boolean
  from?: { readonly name: string }
}) {
  if (mine) {
    return (
      <div className="flex justify-end">
        <div className="max-w-bubble rounded-panel rounded-br-sm bg-surface-2 px-4 py-3 text-body text-ink">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      {from !== undefined && <Avatar name={from.name} size={24} className="mt-1" />}
      <div className="min-w-0">
        {from !== undefined && (
          <span className="mb-1 block text-meta font-title text-ink-3">{from.name}</span>
        )}
        <div className="max-w-bubble rounded-panel rounded-tl-sm bg-surface-2 px-4 py-3 text-body text-ink">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    </div>
  )
}

const SIGNAL_LINE = new Map([
  ['schedule', { Icon: Repeat2, label: 'A routine came due' }],
  ['follow-up', { Icon: AlarmClock, label: 'Time to follow up' }],
])

/**
 * Something the server put in front of Vivid. A `message` signal is a Person speaking in a shared
 * Thread and is drawn as their bubble. A Routine or a follow-up is a quiet line. An Approval's
 * outcome and an answer are not drawn here at all: their cards already say what happened.
 */
function Signal({
  message,
  context,
}: {
  message: FlueConversationMessage
  context: ThreadContext
}) {
  const signal = message.signal
  if (signal === undefined) {
    return (
      <div className="rounded-panel bg-surface-2 px-4 py-3 text-label text-ink-3 ring-line">
        {message.settlement !== undefined && message.settlement.outcome === 'failed'
          ? 'Vivid could not finish that. '
          : ''}
        {textOf(message)}
      </div>
    )
  }
  const attributes = signal.attributes === undefined ? {} : signal.attributes
  if (signal.tagName === 'message') {
    return (
      <Said
        text={textOf(message)}
        // Whose turn it was comes from the Thread's Runs; the conversation holds no identifier.
        mine={Option.exists(
          speakerOfTurn(context.runs, attributes.turn),
          (speaker) => speaker.id === context.me,
        )}
        from={{ name: attributes.from === undefined ? 'Someone' : attributes.from }}
      />
    )
  }
  const line = signal.tagName === undefined ? undefined : SIGNAL_LINE.get(signal.tagName)
  if (line === undefined) return null
  return (
    <div className="flex items-center gap-2 text-meta font-meta text-ink-3">
      <line.Icon className="size-3.5" />
      <span>
        {line.label}
        {attributes.name !== undefined && ` · ${attributes.name}`}
      </span>
    </div>
  )
}

type StepState = 'running' | 'done' | 'failed'

const TOOL_STATE = new Map<string, StepState>([
  ['input-streaming', 'running'],
  ['input-available', 'running'],
  ['output-available', 'done'],
  ['output-error', 'failed'],
])

/** What Vivid did while answering, collapsed to one line that opens into each step. */
function Steps({ tools, live }: { tools: ReadonlyArray<ToolPart>; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) return null
  const steps = tools.map((tool) => ({
    id: tool.toolCallId,
    ...describeToolCall(tool.toolName, null, null, stateOf(tool)),
    failed: tool.state === 'output-error',
  }))
  const running = live && tools.some((tool) => stateOf(tool) === 'running')
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-ml-1 inline-flex cursor-pointer items-center gap-1.5 rounded-row px-1 py-0.5 text-label text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
        {running && <i className="size-1.5 animate-status-pulse rounded-full bg-working" />}
        {running ? 'Working' : tools.length === 1 ? 'Did one thing' : `Did ${tools.length} things`}
      </button>
      {open && (
        <ol className="mt-1 ml-1.5 flex flex-col gap-1 border-l border-line-2 pl-4 text-label text-ink-2">
          {steps.map((step) => (
            <li key={step.id} className={cn(step.failed && 'text-danger')}>
              {step.label}
              {step.detail !== undefined && <span className="text-ink-3"> · {step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** A tool call's standing. A state this client does not know yet is still in progress. */
const stateOf = (tool: ToolPart): StepState => {
  const known = TOOL_STATE.get(tool.state)
  return known === undefined ? 'running' : known
}

/** A Task or follow-up Vivid took on, shown where it was agreed. */
function TrackedCard({ title, assignee }: { title: string; assignee?: string }) {
  return (
    <div className="mt-3 flex items-start gap-3 rounded-panel bg-surface-2 px-3.5 py-3 smooth-shadow-ring-xs">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
        <Check className="size-4" strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-meta font-meta text-ink-3">Vivid is tracking this</span>
        <span className="mt-0.5 block truncate text-label font-title text-ink">{title}</span>
        {assignee !== undefined && assignee.length > 0 && assignee !== 'you' && (
          <span className="mt-0.5 block text-meta font-meta text-ink-3">Waiting on {assignee}</span>
        )}
      </span>
    </div>
  )
}

/** The cards a response's tool results ask for, in the order Vivid produced them. */
function ToolCards({
  tools,
  context,
  onContinue,
}: {
  tools: ReadonlyArray<ToolPart>
  context: ThreadContext
  onContinue: (text: string) => void
}) {
  return tools.map((tool) => {
    if (tool.state !== 'output-available') return null
    const tracked = tool.toolName === 'create_task' ? decodeTracked(tool.output) : Option.none()
    if (Option.isSome(tracked)) {
      return (
        <TrackedCard
          key={tool.toolCallId}
          title={tracked.value.task.title}
          assignee={tracked.value.task.assignee}
        />
      )
    }
    const card = cardFor(tool.output)
    if (Option.isNone(card)) return null
    const wanted = card.value
    if (wanted.kind === 'connection') {
      return (
        <ConnectionCard key={tool.toolCallId} request={wanted.request} onContinue={onContinue} />
      )
    }
    if (wanted.kind === 'approval') {
      const approval = approvalById(context.approvals, wanted.id)
      return Option.isNone(approval) ? null : (
        <ApprovalCard key={tool.toolCallId} approval={approval.value} me={context.me} />
      )
    }
    const request = requestById(context.requests, wanted.id)
    return Option.isNone(request) ? null : (
      <InputCard key={tool.toolCallId} request={request.value} me={context.me} />
    )
  })
}

/** Who Vivid was answering, in a shared Thread where that is not obvious. */
function answering(message: FlueConversationMessage, context: ThreadContext) {
  if (!context.shared) return Option.none<string>()
  const run = context.runs.find((candidate) => candidate.id === message.submissionId)
  return run === undefined ? Option.none<string>() : Option.some(run.origin.person.name)
}

function FromVivid({
  message,
  context,
  working,
  onContinue,
}: {
  message: FlueConversationMessage
  context: ThreadContext
  working: boolean
  onContinue: (text: string) => void
}) {
  const text = textOf(message)
  const tools = message.parts.filter((part) => part.type === 'dynamic-tool')
  const time = timeOf(message)
  const forWhom = answering(message, context)
  const streaming = message.parts.some((part) => 'state' in part && part.state === 'streaming')
  return (
    <div className="flex gap-3">
      <Face size={24} className="mt-1" mood={streaming ? 'thinking' : 'neutral'} />
      <div className="min-w-0 flex-1 text-body text-ink">
        {Option.isSome(forWhom) && (
          <span className="mb-1 block text-meta font-meta text-ink-3">
            Answering {forWhom.value}
          </span>
        )}
        <Steps tools={tools} live={working} />
        {text.length > 0 && <Markdown content={text} />}
        <ToolCards tools={tools} context={context} onContinue={onContinue} />
        {Option.isSome(time) && (
          <span className="mt-1 block text-meta text-ink-3">{time.value}</span>
        )}
      </div>
    </div>
  )
}
