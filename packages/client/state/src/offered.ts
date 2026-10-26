import { SUGGESTED_REPLIES_MOST, SUGGESTED_REPLY_LONGEST, Tool } from '@vivid/contracts'
import { Array as Arr, Option, Schema } from 'effect'

/**
 * The fields of one conversation message that hold Vivid's suggested replies. The shape is Flue's
 * `FlueConversationMessage` (`@flue/sdk` 2.2.2, `dist/index.d.mts`), named structurally so this
 * package reads a message without depending on Flue; each part is read by the schema below.
 */
export interface Offering {
  readonly role: 'user' | 'assistant' | 'system'
  readonly parts: ReadonlyArray<unknown>
}

/**
 * One `suggest_replies` call the runtime accepted (`tools/follow.ts` in `@vivid/agent-runtime`),
 * as Flue keeps it in the conversation: its input is the replies. A call still arriving, or one
 * the runtime refused, has no output and is not an offer. The limits are the runtime's own, so a
 * reply that would not have been accepted is not drawn either.
 */
const Offer = Schema.Struct({
  type: Schema.Literal('dynamic-tool'),
  toolName: Schema.Literal(Tool.suggest_replies),
  state: Schema.Literal('output-available'),
  input: Schema.Struct({
    replies: Schema.NonEmptyArray(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(SUGGESTED_REPLY_LONGEST)),
    ).check(Schema.isMaxLength(SUGGESTED_REPLIES_MOST)),
  }),
})
const readOffer = Schema.decodeUnknownOption(Offer)

const NONE: ReadonlyArray<string> = []

/**
 * The replies Vivid offered a Person to tap under a reply: those of its last `suggest_replies`
 * call, or none. One reading for the web, the desktop and the phone.
 *
 * A surface asks this only of the newest message, and draws the replies only while Vivid is not
 * working: a Person's next message, or Vivid starting again, makes some other message the one in
 * question, so the replies are gone without anything having to remove them.
 */
export const offeredReplies = (message: Offering): ReadonlyArray<string> =>
  message.role !== 'assistant'
    ? NONE
    : Option.match(
        Arr.findLast(message.parts, (part) => readOffer(part)),
        { onNone: () => NONE, onSome: (offer) => offer.input.replies },
      )
