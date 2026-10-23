import type { FlueConversationMessage } from '@flue/sdk'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Option, Record, Schema } from 'effect'

/**
 * What was last said in a Thread, kept on the phone so the Thread is drawn with its words on the
 * first frame.
 *
 * A Thread's conversation is Flue's: its history is one request, begun when the screen that
 * reads it has been drawn. So every opening of a Thread, at launch and from the list, drew grey
 * rows first and the words a round trip later, and asked for the whole history again (156 KB,
 * three times in forty seconds, in production's log of one phone on 10 October 2026). To the
 * Person that is the app loading something it was showing a moment ago.
 *
 * The web keeps a Thread's conversation open in memory after its screen closes
 * (`apps/web/src/data/conversation.ts`). A phone cannot: it suspends the app and ends it when it
 * wants the memory, and an open stream does not outlive either. What survives is what is written
 * down, so here the last words of the most recent Threads are kept in a file and drawn until the
 * conversation's own reading has caught up, which then stands in their place.
 *
 * This module is what is kept and how it is written down. The phone's file and the atoms over it
 * are `data/hearing.ts`, as `data/placed.ts` is to `data/place.ts`.
 */

/** How many of a Thread's newest messages are kept: what its screen opens on, and some above. */
export const TAIL = 40

/** How many Threads are kept: the ones opened most recently. */
export const THREADS = 8

const Progress = Schema.Literals(['streaming', 'done'] as const)

/**
 * One part of a message, as Flue's `FlueConversationPart` has it (`@flue/sdk` 's
 * `index.d.mts`). It is written out here because the SDK publishes the type and no decoder, and
 * text read back from a file is unknown until it has been decoded.
 */
const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String, state: Progress }),
  Schema.Struct({ type: Schema.Literal('reasoning'), text: Schema.String, state: Progress }),
  Schema.Struct({
    type: Schema.Literal('file'),
    mediaType: Schema.String,
    id: Schema.optional(Schema.String),
    size: Schema.optional(Schema.Finite),
    url: Schema.optional(Schema.String),
    filename: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('dynamic-tool'),
    toolName: Schema.String,
    toolCallId: Schema.String,
    state: Schema.Literal('input-available'),
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal('dynamic-tool'),
    toolName: Schema.String,
    toolCallId: Schema.String,
    state: Schema.Literal('output-available'),
    input: Schema.Unknown,
    output: Schema.Unknown,
    durationMs: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal('dynamic-tool'),
    toolName: Schema.String,
    toolCallId: Schema.String,
    state: Schema.Literal('output-error'),
    input: Schema.Unknown,
    errorText: Schema.String,
    durationMs: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.TemplateLiteral(['data-', Schema.String]), data: Schema.Unknown }),
])

/** One message, as Flue's `FlueConversationMessage` has it. */
const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant', 'system'] as const),
  purpose: Schema.Literals(['user', 'assistant', 'dispatch', 'advisory'] as const),
  display: Schema.Literals(['visible', 'hidden', 'diagnostic'] as const),
  submissionId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  signal: Schema.optional(
    Schema.Struct({
      tagName: Schema.optional(Schema.String),
      attributes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  settlement: Schema.optional(
    Schema.Struct({ outcome: Schema.Literals(['failed', 'aborted'] as const) }),
  ),
  timestamp: Schema.optional(Schema.String),
  parts: Schema.mutable(Schema.Array(Part)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

/**
 * One Thread's kept words, the submissions among them that had ended (`settled`, the ids of
 * Flue's settlements, whatever the outcome), and when they were kept, which orders the Threads.
 * The words and the endings are one reading: a reply drawn without its ending would show its
 * displays as still arriving until the conversation is read again.
 *
 * `settled` is required. A file written before it was kept does not decode, and so is nothing
 * kept (`decodeHeard`): its words cannot say which of their replies had ended, and are not
 * drawn as if they could.
 */
const Said = Schema.Struct({
  at: Schema.Finite,
  messages: Schema.Array(Message),
  settled: Schema.Array(Schema.String),
})

/**
 * Whose words are kept: a Person on a server. What a Person was told is theirs alone, so what is
 * kept names them, and is drawn only for them (`heardAt`). Erasing the file when a session ends
 * (`data/hearing.ts`) is not relied on alone: an app can be ended before the erasing lands.
 */
const Whose = Schema.Struct({ origin: Schema.String, person: PersonId })
export type Whose = typeof Whose.Type

/** Everything kept: one Person's recent Threads. Only one Person's are ever kept at a time. */
export const Heard = Schema.Struct({ whose: Whose, threads: Schema.Record(ThreadId, Said) })
export type Heard = typeof Heard.Type

const HeardText = Schema.fromJsonString(Heard)
/** Reads the file's text. Text in a shape this build does not know is nothing kept. */
export const decodeHeard = Schema.decodeUnknownOption(HeardText)
/** The file's text for what is kept. */
export const encodeHeard = Schema.encodeOption(HeardText)

/** A conversation as Flue has it: what was said, and which submissions have ended. */
export interface Conversation {
  readonly messages: ReadonlyArray<FlueConversationMessage>
  readonly settlements: ReadonlyArray<{ readonly submissionId: string }>
}

/**
 * What is kept of a conversation and drawn for a Thread until it is read again: its words, and
 * which submissions among them had ended. Kept, written and read back as one pair.
 */
export interface Kept {
  readonly messages: ReadonlyArray<FlueConversationMessage>
  readonly settled: ReadonlyArray<string>
}

/** Whether a message is still being written: some of its words are still arriving. */
const arriving = (message: FlueConversationMessage) =>
  message.parts.some(
    (part) => (part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming',
  )

/**
 * The part of a conversation worth keeping: its newest `TAIL` messages, without what Vivid is
 * still saying. A half-written answer kept and drawn later would look like Vivid working when it
 * is not.
 *
 * A message of a submission is whole only once Flue has settled that submission, whatever the
 * outcome: Flue closes a text part when a step begins, so a reply with every part finished can
 * still be half a reply, and a failed or stopped reply that has ended is as finished as a
 * completed one. Each message is asked about its own submission, not the last one's: input queued
 * behind a reply still being written ends the conversation in a submission of its own, and the
 * reply before it is still unfinished. A message that names no submission has no ending to wait
 * for, and is kept once its words have stopped arriving. The Person's own words are kept whatever
 * their submission's state: they were said.
 */
export const settledOf = ({ messages, settlements }: Conversation): Kept => {
  const ended = new Set(settlements.map((settlement) => settlement.submissionId))
  const said = (message: FlueConversationMessage) => {
    if (message.role === 'user') return true
    if (message.submissionId === undefined) return !arriving(message)
    return ended.has(message.submissionId)
  }
  const whole = messages.filter(said).slice(-TAIL)
  const settled = new Set(
    whole.flatMap((message) =>
      message.submissionId !== undefined && ended.has(message.submissionId)
        ? [message.submissionId]
        : [],
    ),
  )
  return { messages: whole, settled: [...settled] }
}

const sameWhose = (one: Whose, other: Whose) =>
  one.origin === other.origin && one.person === other.person

/**
 * What was last said in a Thread and which of its replies had ended, when it is kept and is this
 * Person's on this server. The kept lists are handed out as they stand, so a screen is given the
 * same lists until something new is kept. A decoded message is Flue's message and nothing less:
 * typecheck fails here when the SDK's type gains something the schema above does not have, which
 * is when it must be read again.
 */
export const heardAt = (
  kept: Option.Option<Heard>,
  whose: Whose,
  thread: ThreadId,
): Option.Option<Kept> =>
  Option.flatMap(
    Option.filter(kept, (heard) => sameWhose(heard.whose, whose)),
    (heard) => Option.fromUndefinedOr(heard.threads[thread]),
  )

/**
 * What is kept once a Thread has said something. What was kept for anyone else is dropped: it is
 * not this Person's. Of their Threads, the `THREADS` kept most recently stay.
 */
export const withHeard = (
  kept: Option.Option<Heard>,
  whose: Whose,
  heard: { readonly thread: ThreadId; readonly kept: Kept; readonly at: number },
): Heard => {
  const threads: Heard['threads'] = {
    ...Option.match(
      Option.filter(kept, (mine) => sameWhose(mine.whose, whose)),
      { onNone: (): Heard['threads'] => ({}), onSome: (mine) => mine.threads },
    ),
    [heard.thread]: { at: heard.at, messages: heard.kept.messages, settled: heard.kept.settled },
  }
  const newest = Record.toEntries(threads)
    .sort(([, one], [, other]) => other.at - one.at)
    .slice(0, THREADS)
  return { whose, threads: Record.fromEntries(newest) }
}
