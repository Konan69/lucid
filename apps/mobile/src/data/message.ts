import type { FlueConversationMessage } from '@flue/sdk'
import {
  ApprovalId,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  InputRequestId,
  textOf,
  type PersonId,
  type Run,
} from '@vivid/contracts'
import {
  awaitedOf,
  describeToolCall,
  inThread,
  readAnswered,
  readAsked,
  Source,
  sourceOf,
  speakerOfTurn,
  summarizeSteps,
  type Awaited,
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
 * - `Wake`: a follow-up falling due: a quiet line saying why Vivid spoke.
 * - `Notice`: the runtime's word that a reply was not finished. It is the only thing the runtime
 *   says that is drawn, so `failed` is always true.
 * - `Silent`: not drawn. An Approval's outcome and an answer are told by their cards, and the
 *   runtime's notes to itself and the model are for no Person.
 */
export type Speaker = Data.TaggedEnum<{
  Me: {}
  Member: { readonly name: Option.Option<string> }
  Vivid: { readonly answering: Option.Option<string> }
  Wake: { readonly reason: 'follow-up'; readonly name: Option.Option<string> }
  Notice: { readonly failed: boolean }
  Silent: {}
}>
export const Speaker = Data.taggedEnum<Speaker>()

/** Who Vivid was answering, where more than one Person could have asked. */
function answering(message: FlueConversationMessage, around: Around): Option.Option<string> {
  if (!around.shared) return Option.none()
  return Option.map(
    Option.fromUndefinedOr(around.runs.find((run) => run.id === message.submissionId)),
    (run) => run.origin.person.name,
  )
}

/**
 * Who one message is from. Where it came from is the shared reading (`sourceOf` in
 * `@vivid/state`), the same on every surface; this adds what only the Thread around it knows:
 * which Person a turn belongs to, and who Vivid was answering.
 *
 * It read the conversation itself before, and took every `system` message without a signal for a
 * notice. Flue projects its own `instructions` and `environment` signals exactly so, and not
 * hidden, so the phone drew the runtime's notes to the model in the Thread.
 */
export function speakerOf(message: FlueConversationMessage, around: Around): Speaker {
  return Source.$match(sourceOf(message), {
    Person: () => Speaker.Me(),
    Vivid: () => Speaker.Vivid({ answering: answering(message, around) }),
    // Whose turn it was comes from the Thread's Runs; the conversation holds no identifier.
    Said: ({ turn, from }) =>
      Option.exists(speakerOfTurn(around.runs, turn), (speaker) => speaker.id === around.me)
        ? Speaker.Me()
        : Speaker.Member({ name: from }),
    Wake: ({ reason, name }) => Speaker.Wake({ reason, name }),
    Failed: () => Speaker.Notice({ failed: true }),
    Plumbing: () => Speaker.Silent(),
  })
}

/** Whether a message belongs in the Thread at all, by the rule every surface shares. */
export const isShown: (message: FlueConversationMessage) => boolean = inThread

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
  finishedAt: Schema.optionalKey(Schema.Finite),
  startedAt: Schema.optionalKey(Schema.Finite),
})
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

/** When Vivid began a message, when the stream stamped it. */
export const startOf = (message: FlueConversationMessage): Option.Option<number> =>
  Option.flatMap(decodeMetadata(message.metadata), (metadata) =>
    Option.fromUndefinedOr(metadata.startedAt),
  )

/** How long a finished message took, when the stream stamped both ends of it. */
export const tookOf = (message: FlueConversationMessage): Option.Option<number> =>
  Option.flatMap(decodeMetadata(message.metadata), (metadata) =>
    metadata.startedAt !== undefined && metadata.finishedAt !== undefined
      ? Option.some(metadata.finishedAt - metadata.startedAt)
      : Option.none(),
  )

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
  /** The web's ON_COMPUTER tools have something to watch on the Computer screen. */
  readonly onComputer: boolean
}

const STANDING = {
  'input-available': 'running',
  'output-available': 'done',
  'output-error': 'failed',
} as const satisfies Record<ToolPart['state'], Step['standing']>

/** Mirrors the web's watchable steps, without exposing tool names to the drawn UI. */
const ON_COMPUTER = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'browse',
  'use_desktop',
])

/**
 * Each tool call as a line in the product's words, never the tool's own name or payload.
 *
 * One pass with the array's own `flatMap`. It was
 * `tools.values().filter().map().toArray()`, which are methods of the iterator, not of the
 * array. Every Vivid message is drawn through here, and the phone's engine does not promise
 * them: Hermes 250829098.0.17, the one this app is built with, lists iterator helpers as not
 * yet done (`doc/Features.md` at that tag). Node has them, so the tests could not see it.
 */
export const stepsOf = (tools: ReadonlyArray<ToolPart>): ReadonlyArray<Step> =>
  tools.flatMap((tool) => {
    const standing = STANDING[tool.state]
    const described = describeToolCall(
      tool.toolName,
      readAsked(tool.input),
      // A call still running has no output; it reads as an answer with nothing in it yet.
      readAnswered(tool.state === 'output-available' ? tool.output : {}),
      standing,
    )
    return [
      {
        id: tool.toolCallId,
        label: described.label,
        detail: Option.fromUndefinedOr(described.detail),
        // A tool that answered that it could not do it failed, even though the call returned.
        standing: described.state,
        onComputer: ON_COMPUTER.has(tool.toolName),
      },
    ]
  })

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
 * carries what it shows. A Connection request for an Integration Vivid has
 * already begun adding also carries what finishing it takes: a sign-in, or a key.
 */
export type Card = Data.TaggedEnum<{
  Approval: { readonly id: ApprovalId }
  Input: { readonly id: InputRequestId }
  Connection: {
    readonly request: ConnectionRequestMessage
    readonly authorization: Option.Option<Authorization>
    /** Which accounts answer it: any on the service, the one Vivid began, or one more. */
    readonly awaited: Awaited
  }
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

/** Reads a finished tool call for a card. Results that are not cards are simply not cards. */
export function cardOf(tool: ToolPart): Option.Option<Card> {
  if (tool.state !== 'output-available') return Option.none()
  return Option.map(decodeApproval(tool.output), (out) =>
    Card.Approval({ id: out.approvalId }),
  ).pipe(
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
          awaited: awaitedOf(tool.output),
        }),
      ),
    ),
  )
}
