import type { Context } from '@earendil-works/chord'
import type {
  Conversation,
  ConversationDocToken,
  ConversationId,
  DocumentReader,
  Harness,
  JsonObject,
  Tx,
} from '@earendil-works/pi-durable'
import { Effect, Option } from 'effect'

import { ConversationMissing, PiFailed } from './errors.ts'

/** Absence is a domain failure, distinct from rejection of Harness.conversation itself. */
export const conversation = Effect.fn('Durable.conversation')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const found = yield* Effect.tryPromise({
    try: () => harness.conversation(conversationId, context),
    catch: (cause) => new PiFailed({ operation: 'conversation', cause }),
  })
  if (found === undefined) return yield* new ConversationMissing({ conversationId })
  return found
})

/** A document genuinely may not exist yet; preserve that absence for the domain caller. */
export const snapshot = <T extends JsonObject>(
  reader: DocumentReader,
  token: ConversationDocToken<T>,
  conversationId: ConversationId,
  context: Context,
) =>
  Effect.tryPromise({
    try: () => reader.snapshot(token, conversationId, context),
    catch: (cause) => new PiFailed({ operation: 'snapshot', cause }),
  }).pipe(Effect.map(Option.fromNullishOr))

/** Pi serializes and commits the supplied transaction callback atomically. */
export const commit = <A>(
  owner: Pick<Conversation, 'commit'>,
  change: (tx: Tx) => Promise<A>,
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.commit(change, context),
    catch: (cause) => new PiFailed({ operation: 'commit', cause }),
  })

/** Admission is the idempotent Pi operation; consumers select the returned submission id. */
export const submit = (
  owner: Conversation,
  input: Parameters<Conversation['submit']>[0],
  context: Context,
) =>
  Effect.tryPromise({
    try: () => owner.submit(input, context),
    catch: (cause) => new PiFailed({ operation: 'submit', cause }),
  })

/** Resolve the current registry snapshot on each read, because tools can change between turns. */
export const agent = (owner: Conversation, context: Context) =>
  Effect.tryPromise({
    try: () => owner.agent(context),
    catch: (cause) => new PiFailed({ operation: 'agent', cause }),
  })

/** Pi owns transcript selection and context assembly; callers consume its typed view. */
export const view = (owner: Conversation, context: Context) =>
  Effect.tryPromise({
    try: () => owner.context(context),
    catch: (cause) => new PiFailed({ operation: 'context', cause }),
  })
