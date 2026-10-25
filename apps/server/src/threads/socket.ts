import { Effect, Schema, Stream } from 'effect'
import {
  InvalidAttachment,
  MessageAttachment,
  RuntimeUnavailable,
  type SendToThreadRequest,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Forbidden } from '@vivid/contracts'
import { sessionWorkspace } from '../auth/session.ts'
import { requirePerson } from '../auth/access.ts'
import { Runtime, RuntimeRejected, RuntimeTransportFailed } from '../runtime/client.ts'
import { requireThread } from './access.ts'
import { authorized } from './reach.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { messageFingerprint, messagePictures } from './pictures.ts'
import { messageKey } from './key.ts'
import { RunStore } from './runs.ts'

const isRuntimeFailure = Schema.is(Schema.Union([RuntimeRejected, RuntimeTransportFailed]))
const encodePictures = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(MessageAttachment)))

/** Every new link checks current session and audience before pulling any runtime frame. */
export const watchConversation = ({ threadId }: { readonly threadId: ThreadId }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const auth = yield* AuthContext
      if (!AuthState.$is('Person')(auth))
        return yield* new Forbidden({ message: 'Only a signed-in Person can watch' })
      const thread = yield* requireThread(threadId, auth.person.id)
      const runtime = yield* Runtime
      return authorized(
        runtime.watch(thread.personId, thread.id).pipe(
          Stream.mapAccumEffect(
            () => false,
            (seen, frame) =>
              seen
                ? Effect.succeed([true, [frame]] as const)
                : sessionWorkspace(auth.person.id, auth.sessionId).pipe(
                    Effect.andThen(requireThread(thread.id, auth.person.id)),
                    Effect.as([true, [frame]] as const),
                  ),
          ),
        ),
        thread,
        {
          personId: auth.person.id,
          sessionId: auth.sessionId,
        },
      ).pipe(
        Stream.mapError((error) =>
          isRuntimeFailure(error)
            ? RuntimeUnavailable.make({ message: 'Vivid could not be reached' })
            : error,
        ),
      )
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
  return { run: yield* (yield* RunStore).get(receipt.runId) }
})
