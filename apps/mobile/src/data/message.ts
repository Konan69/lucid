import type { FlueConversationMessage } from '@flue/sdk'
import {
  ApprovalId,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  InputRequestId,
  type PersonId,
  type Run,
} from '@vivid/contracts'
import {
  describeToolCall,
  drawn,
  readAnswered,
  readAsked,
  speakerOfTurn,
  summarizeSteps,
} from '@vivid/state'
import { Data, Option, Schema } from 'effect'
import type { Authorization } from './integration'

/**
 * Reading one message of a Thread's conversation: who it is from, what it says, and which card
 * it asks the Thread to draw. Pure functions over what Flue's stream and the Thread's live detail
 * carry; the screen only draws what these return.
 *
 * The rules are the web Thread's (`apps/web/src/screen/thread/Message.tsx`), so a message reads
 * the same on a phone as in a browser.
 */

export type ToolPart = Extract<FlueConversationMessage['parts'][number], { type: 'dynamic-tool' }>

/** What a Thread carries beside its messages, which attribution is read from. */
export interface Around {
  /** The Person holding this phone. */
  readonly me: PersonId
  /** Whether anyone but its creator can see the Thread. */
  readonly shared: boolean
  /** The Thread's Runs. A Run's id is the submission id Flue stamps on Vivid's reply. */
  readonly runs: ReadonlyArray<Run>
}

/**
 * Who a message is from, which decides how it is drawn.
 *
 * - `Me`: the Person holding this phone.
 * - `Member`: someone else in a shared Thread. The server names them on the message; a message
 *   that arrived without a name is drawn without one, never with an invented one.
 * - `Vivid`: Vivid's reply. `answering` names the Person it acted for, in a shared Thread where
 *   that is not obvious.
 * - `Wake`: a Routine coming due or a follow-up falling due: a quiet line saying why Vivid spoke.
 * - `Notice`: something the runtime said with nobody behind it, such as a reply that failed.
 * - `Silent`: not drawn. An Approval's outcome and an answer are told by their cards.
 */
export type Speaker = Data.TaggedEnum<{
  Me: {}
  Member: { readonly name: Option.Option<string> }
  Vivid: { readonly answering: Option.Option<string> }
  Wake: { readonly reason: 'routine' | 'follow-up'; readonly name: Option.Option<string> }
  Notice: { readonly failed: boolean }
  Silent: {}
}>
export const Speaker = Data.taggedEnum<Speaker>()

/** The signals that wake Vivid without a Person speaking, by the tag the server delivers. */
const WAKES = new Map<string, 'routine' | 'follow-up'>([
  ['schedule', 'routine'],
  ['follow-up', 'follow-up'],
])

/**
 * Who a `system`-role message is from. The server delivers everything that is not a private
 * user turn as a signal: a `message` signal is a Person speaking in a shared Thread
 * (`attributes.turn` names the Run that says who they are, `attributes.from` their name).
 */
function signalSpeaker(message: FlueConversationMessage, around: Around): Speaker {
  const signal = message.signal
  if (signal === undefined) {
    const failed = message.settlement !== undefined && message.settlement.outcome === 'failed'
    return Speaker.Notice({ failed })
  }
  const attributes = signal.attributes === undefined ? {} : signal.attributes
  if (signal.tagName === 'message') {
    // Whose turn it was comes from the Thread's Runs; the conversation holds no identifier.
    return Option.exists(
      speakerOfTurn(around.runs, Option.fromUndefinedOr(attributes.turn)),
      (speaker) => speaker.id === around.me,
    )
      ? Speaker.Me()
      : Speaker.Member({ name: Option.fromUndefinedOr(attributes.from) })
  }
  const reason = signal.tagName === undefined ? undefined : WAKES.get(signal.tagName)
  return reason === undefined
    ? Speaker.Silent()
    : Speaker.Wake({ reason, name: Option.fromUndefinedOr(attributes.name) })
}

/** Who Vivid was answering, where more than one Person could have asked. */
function answering(message: FlueConversationMessage, around: Around): Option.Option<string> {
  if (!around.shared) return Option.none()
  return Option.map(
    Option.fromUndefinedOr(around.runs.find((run) => run.id === message.submissionId)),
    (run) => run.origin.person.name,
  )
}

/** Who one message is from. */
export function speakerOf(message: FlueConversationMessage, around: Around): Speaker {
  if (message.role === 'user') return Speaker.Me()
  if (message.role === 'system') return signalSpeaker(message, around)
  return Speaker.Vivid({ answering: answering(message, around) })
}

/**
 * Whether a message belongs in the Thread at all. Flue hides runtime plumbing, but a signal is
 * hidden by default too, and a Person's message in a shared Thread arrives as one.
 */
export const isShown = (message: FlueConversationMessage): boolean =>
  message.display !== 'hidden' || message.signal !== undefined

/** A message's words, each text part its own paragraph. */
export const textOf = (message: FlueConversationMessage): string =>
  message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')

/**
 * The SDK supplies hosted URLs for durable images and data URLs for local previews. Unresolved
 * files have no bytes to draw yet; non-image files belong to the Library, never this gallery.
 * A part's position gives repeated pictures distinct React keys even before durable ids arrive.
 */
export const picturesOf = (message: FlueConversationMessage) =>
  message.parts.flatMap((part, position) => {
    if (part.type !== 'file' || !part.mediaType.startsWith('image/') || part.url === undefined) {
      return []
    }
    return [
      {
        key: `${message.id}:${position}`,
        url: part.url,
        name: Option.fromUndefinedOr(part.filename),
      },
    ]
  })

/** A resolvable image part, retaining the genuine absence of an uploader-provided filename. */
export type MessagePicture = ReturnType<typeof picturesOf>[number]

/**
 * What the Person holding this phone last said in the Thread, which is what "Try again" under a
 * Run that came to nothing says again.
 */
export const lastWordsOf = (
  messages: ReadonlyArray<FlueConversationMessage>,
  around: Around,
): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      messages.findLast((message) => Speaker.$is('Me')(speakerOf(message, around))),
    ),
    textOf,
  )

/** What Vivid did while answering, in the order it did it. */
export const toolsOf = (message: FlueConversationMessage): ReadonlyArray<ToolPart> =>
  message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : []))

/** Whether Vivid is still writing this message. */
export const isStreaming = (message: FlueConversationMessage): boolean =>
  message.parts.some((part) => 'state' in part && part.state === 'streaming')

const Metadata = Schema.Struct({
  finishedAt: Schema.optionalKey(Schema.Number),
  startedAt: Schema.optionalKey(Schema.Number),
})
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

/** When a message was finished, when Vivid said so; an unstamped message simply has no time. */
export const momentOf = (message: FlueConversationMessage): Option.Option<number> =>
  Option.flatMap(decodeMetadata(message.metadata), (metadata) =>
    Option.orElse(Option.fromUndefinedOr(metadata.finishedAt), () =>
      Option.fromUndefinedOr(metadata.startedAt),
    ),
  )

// ── What Vivid did ─────────────────────────────────────────────────────────

/** One thing Vivid did, as a line of the list a reply's steps open into. */
export interface Step {
  readonly id: string
  readonly label: string
  readonly detail: Option.Option<string>
  readonly standing: 'running' | 'done' | 'failed'
}

const STANDING = {
  'input-available': 'running',
  'output-available': 'done',
  'output-error': 'failed',
} as const satisfies Record<ToolPart['state'], Step['standing']>

/** Each tool call as a line in the product's words, never the tool's own name or payload. */
export const stepsOf = (tools: ReadonlyArray<ToolPart>): ReadonlyArray<Step> =>
  tools
    .values()
    .filter((tool) => !drawn(tool))
    .map((tool) => {
      const standing = STANDING[tool.state]
      const described = describeToolCall(
        tool.toolName,
        readAsked(tool.input),
        // A call still running has no output; it reads as an answer with nothing in it yet.
        readAnswered(tool.state === 'output-available' ? tool.output : {}),
        standing,
      )
      return {
        id: tool.toolCallId,
        label: described.label,
        detail: Option.fromUndefinedOr(described.detail),
        standing,
      }
    })
    .toArray()

/**
 * The step Vivid is on: the newest one still in progress, and only while the reply is being
 * written. A call left "running" in a reply that has ended was abandoned, not in progress.
 */
export const currentStepOf = (steps: ReadonlyArray<Step>, working: boolean): Option.Option<Step> =>
  working
    ? Option.fromUndefinedOr(steps.findLast((step) => step.standing === 'running'))
    : Option.none()

/**
 * The one line the steps collapse to, in the words every surface uses (`summarizeSteps` in
 * `@vivid/state`): what Vivid is doing right now while it works, what it did once it has.
 */
export const stepsSummary = (steps: ReadonlyArray<Step>, working: boolean): string =>
  summarizeSteps(
    steps,
    Option.map(currentStepOf(steps, working), (step) => step.id),
  )

// ── Cards ──────────────────────────────────────────────────────────────────

/**
 * What a tool's result asks the Thread to draw in place of plain text.
 *
 * An Approval and an Input request name a record the Thread's live detail carries; the card is
 * drawn from that record, so it keeps telling the truth after it is settled. A Connection request
 * and a tracked Task carry what they show. A Connection request for an Integration Vivid has
 * already begun adding also carries what finishing it takes: a sign-in, or a key.
 */
export type Card = Data.TaggedEnum<{
  Approval: { readonly id: ApprovalId }
  Input: { readonly id: InputRequestId }
  Connection: {
    readonly request: ConnectionRequestMessage
    readonly authorization: Option.Option<Authorization>
  }
  Tracked: { readonly title: string; readonly waitingOn: Option.Option<string> }
}>
export const Card = Data.taggedEnum<Card>()

const decodeApproval = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('approval-request'), approvalId: ApprovalId }),
)
const decodeInput = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('input-request'), requestId: InputRequestId }),
)
const decodeConnection = Schema.decodeUnknownOption(ConnectionRequestMessage)
// The same message with one more field: what comes next for an Integration already begun.
const decodeAuthorization = Schema.decodeUnknownOption(ConnectionAuthorizationMessage)

/**
 * What `create_task` answers with. The runtime writes the assignee as a name, and as `you` when
 * the Task is the asker's own (`packages/agent/runtime/src/tools/tasks.ts`).
 */
const decodeTracked = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.Struct({ title: Schema.String, assignee: Schema.optionalKey(Schema.String) }),
  }),
)

const trackedCard = (tool: ToolPart): Option.Option<Card> =>
  Option.map(tool.toolName === 'create_task' ? decodeTracked(tool.output) : Option.none(), (out) =>
    Card.Tracked({
      title: out.task.title,
      waitingOn: Option.filter(
        Option.fromUndefinedOr(out.task.assignee),
        (assignee) => assignee !== '' && assignee !== 'you',
      ),
    }),
  )

/** Reads a finished tool call for a card. Results that are not cards are simply not cards. */
export function cardOf(tool: ToolPart): Option.Option<Card> {
  if (tool.state !== 'output-available') return Option.none()
  return trackedCard(tool).pipe(
    Option.orElse(() =>
      Option.map(decodeApproval(tool.output), (out) => Card.Approval({ id: out.approvalId })),
    ),
    Option.orElse(() =>
      Option.map(decodeInput(tool.output), (out) => Card.Input({ id: out.requestId })),
    ),
    Option.orElse(() =>
      Option.map(decodeConnection(tool.output), (request) =>
        Card.Connection({
          request,
          authorization: Option.map(
            decodeAuthorization(tool.output),
            (message) => message.authorization,
          ),
        }),
      ),
    ),
  )
}
