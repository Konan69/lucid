import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, EntryId } from '@earendil-works/pi-durable'
import { Effect, Option, Predicate, Schema } from 'effect'
import { isPersonEntry } from '../delivery.ts'
import { pi } from '../threads.ts'

/** A picture's name in the state: the entry it was sent in and its place in that message. */
const Named = Schema.TemplateLiteralParser([
  Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  '-',
  Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
])
const decodeNamed = Schema.decodeUnknownOption(Named)

/** Pi brands its ids in the type system only; an entry id is a positive integer. */
const isEntryId = (value: number): value is EntryId => Number.isSafeInteger(value) && value > 0

/**
 * The bytes of one picture a Person sent, by the name the state gives it (`project.ts`
 * `pictureId`). Pi keeps a picture inside the user message it came with, as base64 beside its
 * media type, so this reads that one entry through the conversation, which answers only for
 * entries the conversation can see: a name from another Thread finds nothing. Anything that is
 * not a picture in a Person's message finds nothing either.
 */
export const picture = Effect.fn('Pictures.picture')(function* (
  conversation: Conversation,
  name: string,
) {
  const named = decodeNamed(name)
  if (Option.isNone(named)) return Option.none()
  const [entry, , index] = named.value
  if (!isEntryId(entry)) return Option.none()
  const page = yield* pi(() =>
    conversation.entries(
      { minEntryId: entry, maxEntryId: entry },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    ),
  )
  const [found] = page.items
  if (found === undefined || !isPersonEntry(found.kind) || found.model === undefined)
    return Option.none()
  const [message] = found.model
  if (message === undefined || message.role !== 'user' || Predicate.isString(message.content))
    return Option.none()
  const block = message.content[index]
  if (block === undefined || block.type !== 'image') return Option.none()
  return Option.some({ mediaType: block.mimeType, bytes: Buffer.from(block.data, 'base64') })
})
