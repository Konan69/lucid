import { Effect, Option, Predicate, Schedule, Schema, Stream } from 'effect'
import {
  InvalidAttachment,
  MessageAttachment,
  InvalidRequest,
  NotFound,
  SignalCue,
  type SendToThreadRequest,
  type CarryOnRequest,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Forbidden } from '@vivid/contracts'
import { requirePerson } from '../auth/access.ts'
import { endWithdrawals } from '../inputs/handoff.ts'
import { InputStore } from '../inputs/store.ts'
import { Runtime } from '../runtime/client.ts'
import { requireThread } from './access.ts'
import { authorized } from './reach.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { messageFingerprint, messagePictures } from './pictures.ts'
import { messageKey } from './key.ts'
import { RunStore } from './runs.ts'

const encodePictures = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(MessageAttachment)))

/** Keep a public watch open across owner loss, with access checks covering every runtime link. */
export const watchConversation = ({ threadId }: { readonly threadId: ThreadId }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const auth = yield* AuthContext
      if (!AuthState.$is('Person')(auth))
        return yield* new Forbidden({ message: 'Only a signed-in Person can watch' })
      const thread = yield* requireThread(threadId, auth.person.id)
      const runtime = yield* Runtime
      // Every reopened runtime link starts with Whole. Use the client's reconnect pacing while
      // celld finds the successor; authorization stays outside recovery so removal interrupts it.
      const frames = runtime.watch(thread.personId, thread.id).pipe(
        Stream.retry(($) =>
          $(
            Schedule.min([Schedule.exponential('1500 millis'), Schedule.spaced('30 seconds')]),
          ).pipe(
            Schedule.while(({ input }) => Predicate.isTagged(input, 'RuntimeUnavailable')),
            Schedule.jittered,
          ),
        ),
        Stream.repeat(Schedule.spaced('1500 millis').pipe(Schedule.jittered)),
      )
      return authorized(frames, thread, {
        personId: auth.person.id,
        sessionId: auth.sessionId,
      })
    }),
  )

/** Picture checks and immutable fingerprints precede reservation, as they did in the HTTP gateway. */
export const sendToThread = Effect.fn('Rpc.SendToThread')(function* (request: SendToThreadRequest) {
  const auth = yield* requirePerson()
  const thread = yield* requireThread(request.threadId, auth.person.id)
  const pictures = yield* encodePictures(request.pictures).pipe(
    Effect.mapError(
      () => new InvalidAttachment({ message: 'Send a picture with valid attachment fields.' }),
    ),
  )
  const attachments = yield* messagePictures(
    { kind: 'user', body: request.text, idempotencyKey: request.key, attachments: pictures },
    thread,
  )
  // A picture may be the whole send, but an empty composer must reserve no Run.
  if (request.text.length === 0 && attachments.length === 0)
    return yield* new InvalidRequest({ message: 'A message needs text or a picture' })
  const receipt = yield* (yield* Conversation).admit({
    threadId: thread.id,
    personId: auth.person.id,
    speaker: DeliverySpeaker.cases.Acting.make({}),
    message: DeliveryMessage.cases.Said.make({ body: request.text, attachments }),
    origin: StoredRunOrigin.cases.Message.make({
      fingerprint: messageFingerprint(request.text, attachments),
    }),
    idempotencyKey: messageKey(auth.person.id, request.key),
    clientKey: request.key,
  })
  // The message withdrew this Person's open handoffs here (`delivery.ts`); their fields are
  // emptied before the Computer goes back. The message is already accepted, so a clearing that
  // fails leaves that step held for the Person to withdraw again, and the send still answers.
  yield* endWithdrawals(thread.id, auth.person.id).pipe(
    Effect.catchTag(['HandoffNotCleared', 'HandoffComputerUnavailable'], (failure) =>
      Effect.logWarning('A withdrawn handoff could not be cleared yet', { failure: failure._tag }),
    ),
  )
  // The message withdrew this Person's waiting Integration questions too; each still holds a
  // paused call, which is cancelled now so the Integration does not wait out its deadline. The
  // message is accepted whatever happens, so a failed cancel is logged, not answered.
  yield* (yield* InputStore)
    .cancelWithdrawn(
      {
        person: auth.person,
        workspace: auth.workspace,
        by: 'person',
        threadId: Option.some(thread.id),
        helper: Option.none(),
      },
      thread.id,
    )
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning('A withdrawn Integration question could not be cancelled', {
          failure: failure._tag,
        }),
      ),
    )
  const runs = yield* (yield* RunStore).list(thread.id)
  const run = runs.find((candidate) => candidate.id === receipt.runId)
  if (run === undefined) return yield* new NotFound({ message: 'Admitted Run not found' })
  return { run }
})

/** Preserve the card's signal identity and Person authority through native admission. */
export const carryOnThread = Effect.fn('Rpc.CarryOnThread')(function* (request: CarryOnRequest) {
  const auth = yield* requirePerson()
  const thread = yield* requireThread(request.threadId, auth.person.id)
  yield* (yield* Conversation).admit({
    threadId: thread.id,
    personId: auth.person.id,
    speaker: DeliverySpeaker.cases.Acting.make({}),
    message: DeliveryMessage.cases.Signal.make({
      cue: SignalCue.cases.CarryOn.make({ body: request.body }),
    }),
    origin: StoredRunOrigin.cases.Message.make({
      fingerprint: messageFingerprint(request.body, []),
    }),
    idempotencyKey: messageKey(auth.person.id, request.key),
    clientKey: request.key,
  })
})
