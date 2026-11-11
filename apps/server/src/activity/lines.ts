import type { ConversationState } from '@vivid/contracts'
import { Option, Schema } from 'effect'

/**
 * The words a Live Activity row shows under a Thread's title, read from the Thread's own
 * conversation. Nothing here is invented: a step is what Vivid wrote as the purpose of the tool
 * call it is making, and a result is the first sentence of the reply that ended the Run.
 */

/** Every runtime tool's input carries `summary`, Vivid's own words for what the call is for. */
const decodeSummary = Schema.decodeUnknownOption(Schema.Struct({ summary: Schema.String }))

/** A result longer than this would take more than the card's two lines; the row then shows none. */
const RESULT_MAX = 90

type Message = ConversationState['messages'][number]

/** The reply being written now: the last visible message from Vivid. */
const lastReply = (state: ConversationState): Option.Option<Message> =>
  Option.fromUndefinedOr(
    state.messages.findLast(
      (message) => message.role === 'assistant' && message.display === 'visible',
    ),
  )

/**
 * What Vivid is doing now: the purpose of the newest tool call in the reply that has not answered
 * yet. Between calls (Vivid thinking or writing) there is no step, and the row keeps no line.
 */
export const stepOf = (state: ConversationState): Option.Option<string> =>
  Option.flatMap(lastReply(state), (reply) => {
    const running = reply.parts.findLast(
      (part) => part.type === 'dynamic-tool' && part.state === 'input-available',
    )
    if (running === undefined || running.type !== 'dynamic-tool') return Option.none()
    return Option.flatMap(decodeSummary(running.input), ({ summary }) => sentence(summary))
  })

/** How the Run ended, in Vivid's words: the first sentence of the reply that answered it. */
export const resultOf = (reply: string): Option.Option<string> =>
  Option.filter(sentence(reply), (first) => first.length <= RESULT_MAX)

/** The first sentence of some prose, without Markdown marks, or none if it has no words. */
const sentence = (prose: string): Option.Option<string> => {
  const plain = prose
    .replace(/[*_`#>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  // A sentence ends at . ! or ? followed by a space; a full stop at the end is dropped.
  return Option.filter(
    Option.map(Option.fromUndefinedOr(plain.split(/(?<=[.!?])\s/u)[0]), (first) =>
      first.replace(/[.]$/u, '').trim(),
    ),
    (first) => first.length > 0,
  )
}
