import { eq } from 'drizzle-orm'
import { Effect, Option, Schema, Stream } from 'effect'
import * as Sse from 'effect/encoding/Sse'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  ConversationFrame,
  ConversationTooLarge,
  InvalidAttachment,
  MessageAttachment,
  NotFound,
  Run,
  RuntimeUnavailable,
  emptyConversation,
  type SendToThreadRequest,
  type ThreadId,
} from '@vivid/contracts'
import { requirePerson } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { submissionId } from '../runtime/identity.ts'
import { requireThread } from './access.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { authorizedBody, messageKey } from './gateway.ts'
import { messageFingerprint, messagePictures } from './pictures.ts'
import { FlueHistory, projectConversation } from './projection.ts'
import { RunStore } from './runs.ts'
import { messageKeys } from './tables.ts'

// Matches the Pi relay's runtime/transport.ts:conversationFrameLimit, in UTF-16 code units.
const frameLimit = 32 * 1024 * 1024
const decodeHistory = HttpClientResponse.schemaBodyJson(FlueHistory)
const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(ConversationFrame))
const encodePictures = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(MessageAttachment)))
const unavailable = () => RuntimeUnavailable.make({ message: 'The conversation could not be read' })

/** A missing runtime conversation is an empty product Thread, not a missing Thread. */
const readHistory = Effect.fn('Conversation.history')(function* (threadId: ThreadId) {
  const response = yield* (yield* Runtime).read({
    threadId,
    suffix: '',
    search: '?view=history',
    accept: 'application/json',
  })
  if (response.status === 404) return Option.none<FlueHistory>()
  if (response.status !== 200) return yield* unavailable()
  return Option.some(yield* decodeHistory(response).pipe(Effect.mapError(unavailable)))
}, Effect.scoped)

/**
 * Flue creates its stream on first admission. Recheck after subscribing to close the 404 race.
 * This finite scope releases the product change subscription before following Flue, so an
 * open Thread never retains an unread queue of unrelated product notifications.
 */
const waitForHistory = Effect.fn('Conversation.appeared')(function* (threadId: ThreadId) {
  const changed = yield* (yield* Changes).subscribe([Topic.thread(threadId)], ['activity'])
  const current = yield* readHistory(threadId)
  if (Option.isSome(current)) return current.value
  const appeared = yield* changed.pipe(
    Stream.mapEffect(() => readHistory(threadId)),
    Stream.filter(Option.isSome),
    Stream.map((history) => history.value),
    Stream.runHead,
  )
  if (Option.isNone(appeared)) return yield* unavailable()
  return appeared.value
}, Effect.scoped)

/** Echo keys were committed before admission, so even the first runtime update can recognise a send. */
const whole = Effect.fn('Conversation.whole')(function* (threadId: ThreadId, history: FlueHistory) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(messageKeys).where(eq(messageKeys.threadId, threadId)),
  )
  const frame = ConversationFrame.cases.Whole.make({
    state: projectConversation(history, threadId, new Map(rows.map((row) => [row.runId, row.key]))),
  })
  const encoded = yield* encodeFrame(frame).pipe(Effect.mapError(unavailable))
  if (encoded.length > frameLimit)
    return yield* ConversationTooLarge.make({ threadId, limit: frameLimit })
  return frame
})

/**
 * History's offset closes the hydration/subscription gap. Updates only invalidate that history;
 * Flue remains the owner of folding deltas, tool results, retries and resets into messages.
 * Flue 2.2.2 dispatch:sseResponse emits JSON batches as data and transport receipts as control.
 */
const followHistory = (threadId: ThreadId, history: FlueHistory) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const first = yield* whole(threadId, history)
      const response = yield* (yield* Runtime).read({
        threadId,
        suffix: '',
        search: `?${new URLSearchParams({ view: 'updates', offset: history.offset, live: 'sse' }).toString()}`,
        accept: 'text/event-stream',
      })
      if (response.status !== 200) return yield* unavailable()
      const updates = response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode({ maxEventSize: frameLimit })),
        Stream.mapError(unavailable),
        Stream.filter((event) => event.event === 'data'),
        Stream.mapEffect(() => readHistory(threadId)),
        Stream.mapEffect((current) =>
          Option.isSome(current) ? whole(threadId, current.value) : Effect.fail(unavailable()),
        ),
      )
      return Stream.concat(Stream.succeed(first), updates)
    }),
  )

/** Every new link hydrates afresh. Gateway authorization also closes idle links on revocation or expiry. */
export const watchConversation = ({ threadId }: { readonly threadId: ThreadId }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const auth = yield* requirePerson()
      const thread = yield* requireThread(threadId, auth.person.id)
      const history = yield* readHistory(threadId)
      const frames = Option.isSome(history)
        ? followHistory(threadId, history.value)
        : Stream.concat(
            Stream.succeed(ConversationFrame.cases.Whole.make({ state: emptyConversation })),
            Stream.unwrap(
              waitForHistory(threadId).pipe(
                Effect.map((current) => followHistory(threadId, current)),
              ),
            ),
          )
      return authorizedBody({ stream: frames }, thread, {
        personId: auth.person.id,
        sessionId: auth.sessionId,
      })
    }),
  )

/** The same picture checks, immutable fingerprint and admission path as the existing HTTP gateway. */
export const sendToThread = Effect.fn('Rpc.SendToThread')(function* (request: SendToThreadRequest) {
  const auth = yield* requirePerson()
  const thread = yield* requireThread(request.threadId, auth.person.id)
  const pictures = yield* encodePictures(request.pictures).pipe(
    Effect.mapError(() =>
      InvalidAttachment.make({ message: 'Send a picture with valid attachment fields.' }),
    ),
  )
  const attachments = yield* messagePictures(
    {
      kind: 'user',
      body: request.text,
      idempotencyKey: request.key,
      attachments: pictures,
    },
    thread,
  )
  const key = messageKey(auth.person.id, request.key)
  const database = yield* Database
  yield* database.run(
    database
      .insert(messageKeys)
      .values({
        runId: submissionId(thread.id, key),
        threadId: thread.id,
        key: request.key,
      })
      .onConflictDoNothing(),
  )
  const receipt = yield* (yield* Conversation).admit({
    threadId: thread.id,
    personId: auth.person.id,
    speaker: DeliverySpeaker.cases.Acting.make({}),
    message: DeliveryMessage.cases.Said.make({ body: request.text, attachments }),
    origin: StoredRunOrigin.cases.Message.make({
      fingerprint: messageFingerprint(request.text, attachments),
    }),
    idempotencyKey: key,
  })
  const run = (yield* (yield* RunStore).list(thread.id)).find(
    (candidate) => candidate.id === receipt.runId,
  )
  if (run === undefined) return yield* NotFound.make({ message: 'Run not found' })
  return {
    run: Run.make({
      id: run.id,
      threadId: run.threadId,
      turn: run.turn,
      origin: run.origin,
      state: run.state,
      startedAt: run.startedAt,
      submissionId: run.id,
    }),
  }
})
