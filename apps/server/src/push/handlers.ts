import { Activities } from '../activity/service.ts'
import type { ActivityRegistration } from '@vivid/contracts'
import { Effect } from 'effect'
import {
  PushKeyResponse,
  PushTargetListResponse,
  PushTargetResponse,
  type RegisterPushTargetRequest,
  type PushTargetId,
  type NotifyPersonRequest,
} from '@vivid/contracts'
import { requirePerson, requireVivid } from '../auth/access.ts'
import { notifyPerson } from '../notifications/attention.ts'
import { PushConfig } from './config.ts'
import { PushTargets } from './targets.ts'

/** Push endpoints are personal, even while the client has a Company workspace selected. */
const loadTargets = Effect.fn('Rpc.loadPushTargets')(function* (
  personId: import('@vivid/contracts').PersonId,
) {
  return PushTargetListResponse.make({ targets: yield* (yield* PushTargets).list(personId) })
})

export const pushHandlers = {
  /** ActivityKit tokens are personal and tied to this authenticated session. */
  RegisterActivity: Effect.fn('Rpc.RegisterActivity')(function* (request: ActivityRegistration) {
    const auth = yield* requirePerson()
    yield* (yield* Activities).register(auth.person.id, auth.sessionId, request)
  }),
  /** Permission is obtained by the client; this call binds its credential to this live session. */
  RegisterPushTarget: Effect.fn('Rpc.RegisterPushTarget')(function* (
    request: typeof RegisterPushTargetRequest.Type,
  ) {
    const auth = yield* requirePerson()
    return PushTargetResponse.make({
      target: yield* (yield* PushTargets).register({
        personId: auth.person.id,
        sessionId: auth.sessionId,
        destination: request.destination,
      }),
    })
  }),
  /** Listing never grants the model or another Person access to notification addresses. */
  ListPushTargets: Effect.fn('Rpc.ListPushTargets')(function* () {
    return yield* loadTargets((yield* requirePerson()).person.id)
  }),
  /** Removes only the caller's target; guessed or removed ids remain harmless. */
  RemovePushTarget: Effect.fn('Rpc.RemovePushTarget')(function* ({
    id,
  }: {
    readonly id: PushTargetId
  }) {
    yield* (yield* PushTargets).remove((yield* requirePerson()).person.id, id)
  }),
  /** Public VAPID material is safe for a client bundle; the private key stays in the adapter. */
  GetPushKey: Effect.fn('Rpc.GetPushKey')(function* () {
    yield* requirePerson()
    return PushKeyResponse.make({ publicKey: (yield* PushConfig).publicKey })
  }),
  /** Recipient and Thread are authenticated runtime context, never model-supplied authority. */
  NotifyPerson: Effect.fn('Rpc.NotifyPerson')(function* (message: typeof NotifyPersonRequest.Type) {
    const auth = yield* requireVivid()
    return yield* notifyPerson({ personId: auth.person.id, threadId: auth.threadId, message })
  }),
}
