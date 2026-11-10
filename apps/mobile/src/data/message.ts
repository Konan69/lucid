import {
  ApprovalId,
  type ArtifactReference,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  HandoffId,
  InputRequestId,
  textOf,
  type ConversationMessage,
  type PersonId,
  type Run,
  type ThreadId,
} from '@vivid/contracts'
import {
  artifacts,
  awaitedOf,
  describeToolCall,
  inThread,
  pictureAddress,
  readAnswered,
  readAsked,
  runOf,
  Source,
  sourceOf,
  speakerOfTurn,
  type Awaited,
} from '@vivid/state'
import { Data, Option, Schema } from 'effect'
import type { Authorization } from './integration'
import type { ServerAddress } from './server'

/**
 * Reading one message of a Thread's conversation: who it is from, what it says, and which card
 * it asks the Thread to draw. Pure functions over what the Thread's conversation and its live
 * detail carry; the screen only draws what these return.
 *
 * The rules are the web Thread's (`apps/web/src/screen/thread/Message.tsx`), so a message reads
 * the same on a phone as in a browser.
 */

export type ToolPart = Extract<ConversationMessage['parts'][number], { type: 'dynamic-tool' }>

/** What a Thread carries beside its messages, which attribution is read from. */
export interface Around {
  /** The Person holding this phone. */
  readonly me: PersonId
  /** Whether anyone but its creator can see the Thread. */
  readonly shared: boolean
  /**
   * The Thread's Runs. A reply names the delivery it answers by the Run's number in the runtime
   * (`Run.submissionId`), never by the Run's own id (`runOf`, `@vivid/state`).
   */
  readonly runs: ReadonlyArray<Run>
  /** Where a picture in one of the Thread's messages is read from, and as whom. */
  readonly hosted: Hosted
}

/**
 * Where the pictures of one Thread's messages are kept: the Person's server and the Thread, and
 * the header that says who is asking (`bearer`, `data/transport.ts`), which is what the server
 * lets a picture be read by. The header is made by whoever holds the session; nothing here
 * reads a token.
 */
export interface Hosted {
  readonly server: ServerAddress
  readonly thread: ThreadId
  readonly asking: Readonly<Record<string, string>>
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
 * - `Saw`: the event a Watch woke Vivid with, drawn whole under a quiet line.
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
  Saw: { readonly name: Option.Option<string> }
  Notice: { readonly failed: boolean }
  Silent: {}
}>
export const Speaker = Data.taggedEnum<Speaker>()

/** Who Vivid was answering, where more than one Person could have asked. */
function answering(message: ConversationMessage, around: Around): Option.Option<string> {
  if (!around.shared) return Option.none()
  return Option.map(runOf(around.runs, message), (run) => run.origin.person.name)
}

/**
 * Who one message is from. Where it came from is the shared reading (`sourceOf` in
 * `@vivid/state`), the same on every surface; this adds what only the Thread around it knows:
 * which Person a turn belongs to, and who Vivid was answering.
 *
 * It read the conversation itself before, and took every `system` message without a signal for a
 * notice, so the phone drew the runtime's notes to the model in the Thread.
 */
export function speakerOf(message: ConversationMessage, around: Around): Speaker {
  return Source.$match(sourceOf(message), {
    Person: () => Speaker.Me(),
    Vivid: () => Speaker.Vivid({ answering: answering(message, around) }),
    // Whose turn it was comes from the Thread's Runs; the conversation holds no identifier.
    Said: ({ turn, from }) =>
      Option.exists(speakerOfTurn(around.runs, turn), (speaker) => speaker.id === around.me)
        ? Speaker.Me()
        : Speaker.Member({ name: from }),
    Wake: ({ reason, name }) => Speaker.Wake({ reason, name }),
    Saw: ({ name }) => Speaker.Saw({ name }),
    Failed: () => Speaker.Notice({ failed: true }),
    Plumbing: () => Speaker.Silent(),
  })
}

/** Whether a message belongs in the Thread at all, by the rule every surface shares. */
export const isShown: (message: ConversationMessage) => boolean = inThread

/**
 * A message's pictures, each with where its bytes are read. A stored picture is on the Person's
 * server under its Thread (`pictureAddress`, `@vivid/state`) and is asked for as the signed-in
 * Person: a phone has no cookie, so the header that says who is asking goes with the request
 * (`Hosted.asking`). Any other address is drawn
 * as it is, with nothing sent beside it: bytes this phone already holds (`data:`).
 *
 * A file with no address has no bytes to draw yet; non-image files belong to the Library, never
 * this gallery. A part's position gives repeated pictures distinct React keys.
 */
export const picturesOf = (message: ConversationMessage, hosted: Hosted) =>
  message.parts.flatMap((part, position) => {
    if (part.type !== 'file' || !part.mediaType.startsWith('image/') || part.url === undefined) {
      return []
    }
    const path = pictureAddress(hosted.thread, part.url)
    const stored = path !== part.url
    return [
      {
        key: `${message.id}:${position}`,
        url: stored ? `${hosted.server}${path}` : part.url,
        // Only to the Person's own server: who is asking is never said to another address.
        headers: stored ? Option.some(hosted.asking) : Option.none(),
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
  messages: ReadonlyArray<ConversationMessage>,
  around: Around,
): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      messages.findLast((message) => Speaker.$is('Me')(speakerOf(message, around))),
    ),
    textOf,
  )

/** What Vivid did while answering, in the order it did it. */
export const toolsOf = (message: ConversationMessage): ReadonlyArray<ToolPart> =>
  message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : []))

/**
 * A reply as the Person reads it: what Vivid said and what it showed, in the order it happened.
 * Each stretch of words between two pieces of work is a message of its own (Duet and Grok Bot
 * both split a turn this way), and the work between them is drawn only where it left something
 * for the Person, a card (`Cards`). Steps themselves are never drawn in the Thread; the working
 * bubble says the one Vivid is on (`ui/Thinking.tsx`).
 */
export type Segment = Data.TaggedEnum<{
  Words: { readonly text: string }
  Work: { readonly tools: ReadonlyArray<ToolPart> }
}>
export const Segment = Data.taggedEnum<Segment>()

/**
 * Splits a reply into its segments. Text parts that follow one another are one stretch of words,
 * joined as `textOf` joins them; tool calls that follow one another are one piece of work. Empty
 * words make no segment, so a reply that has only begun has none.
 */
export const segmentsOf = (message: ConversationMessage): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = []
  for (const part of message.parts) {
    const last = segments.at(-1)
    if (part.type === 'text') {
      if (part.text.trim().length === 0) continue
      if (last !== undefined && Segment.$is('Words')(last))
        segments[segments.length - 1] = Segment.Words({ text: `${last.text}\n\n${part.text}` })
      else segments.push(Segment.Words({ text: part.text }))
    } else if (part.type === 'dynamic-tool') {
      if (last !== undefined && Segment.$is('Work')(last))
        segments[segments.length - 1] = Segment.Work({ tools: [...last.tools, part] })
      else segments.push(Segment.Work({ tools: [part] }))
    }
  }
  return segments
}

/** Whether Vivid is still writing this message. */
export const isStreaming = (message: ConversationMessage): boolean =>
  message.parts.some((part) => 'state' in part && part.state === 'streaming')

/** When a message was finished, when Vivid said so; an unstamped message simply has no time. */
export const momentOf = (message: ConversationMessage): Option.Option<number> =>
  Option.flatMap(Option.fromUndefinedOr(message.metadata), (metadata) =>
    Option.orElse(Option.fromUndefinedOr(metadata.finishedAt), () =>
      Option.fromUndefinedOr(metadata.startedAt),
    ),
  )

// ── What Vivid did ─────────────────────────────────────────────────────────

/** One thing Vivid did, as a line of the list a reply's steps open into. */
interface Step {
  readonly id: string
  readonly label: string
  readonly detail: Option.Option<string>
  readonly standing: 'running' | 'done' | 'failed'
  /** The web's ON_COMPUTER tools have something to watch on the Computer screen. */
  readonly onComputer: boolean
  /** The Integration account the step works through, when it names one (`describeToolCall`). */
  readonly account: Option.Option<string>
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
const stepsOf = (tools: ReadonlyArray<ToolPart>): ReadonlyArray<Step> =>
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
        account: described.account,
      },
    ]
  })

/**
 * The step Vivid is on: the newest one still in progress, and only while the reply is being
 * written. A call left "running" in a reply that has ended was abandoned, not in progress.
 */
const currentStepOf = (steps: ReadonlyArray<Step>, working: boolean): Option.Option<Step> =>
  working
    ? Option.fromUndefinedOr(steps.findLast((step) => step.standing === 'running'))
    : Option.none()

/**
 * What Vivid is on while it works, for the working bubble (`ui/Thinking.tsx`): the step it is
 * taking in the newest reply, in that step's own words ("Using Grain"), and the Integration
 * account it works through, whose logo stands beside the words. None while it is on no step.
 */
export interface Doing {
  readonly words: string
  readonly account: Option.Option<string>
}

/** The step Vivid is on in the newest reply, while it is working (`currentStepOf`). */
export const doingOf = (
  messages: ReadonlyArray<ConversationMessage>,
  working: boolean,
): Option.Option<Doing> => {
  const newest = messages.at(-1)
  if (newest === undefined || newest.role !== 'assistant') return Option.none()
  return Option.map(currentStepOf(stepsOf(toolsOf(newest)), working), (step) => ({
    words: step.label,
    account: step.account,
  }))
}

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
  /** A step on the Computer Vivid handed the Person (`inputs/handoff.ts` on the server). */
  Handoff: { readonly id: HandoffId }
  /** A file or document Vivid delivered (`write_document`, `publish_file`). */
  Artifact: { readonly artifact: typeof ArtifactReference.Type }
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
const decodeHandoff = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('handoff'), handoffId: HandoffId }),
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
      Option.map(decodeHandoff(tool.output), (out) => Card.Handoff({ id: out.handoffId })),
    ),
    Option.orElse(() =>
      Option.map(artifacts.deliveredArtifact(tool.output), (artifact) =>
        Card.Artifact({ artifact }),
      ),
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
