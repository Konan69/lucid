import { expect } from '@effect/vitest'
import {
  PersonId,
  RuntimeAdmissionReceipt,
  RuntimeSettlement,
  SignalCue,
  type RuntimeSubmissionId,
} from '@vivid/contracts'
import { Effect, Schema, type Scope } from 'effect'
import { start, world, type World } from './process.ts'

export const ada = PersonId.make('person-7f3a')
export const grace = PersonId.make('person-c41d')

const decodeReceipt = Schema.decodeUnknownEffect(RuntimeAdmissionReceipt)
export const decodeSettlement = Schema.decodeUnknownEffect(RuntimeSettlement)

export type Runtime = Effect.Success<ReturnType<typeof start>>

/** One delivery as the application server encodes it; a private message unless a case says otherwise. */
export const delivery = (
  threadId: string,
  key: string,
  given: {
    readonly creator?: PersonId
    readonly body?: string
    /** A signal from this speaker; without it the delivery is a Person's private words. */
    readonly from?: string
    /** What the signal says; a shared message with `body` when only `from` is given. */
    readonly cue?: SignalCue
    readonly acting?: PersonId
    readonly turn?: number
    readonly clientKey?: string
    readonly attachments?: ReadonlyArray<{
      readonly type: 'image'
      readonly data: string
      readonly mimeType: string
    }>
  } = {},
) => {
  const creator = given.creator === undefined ? ada : given.creator
  const words = given.body === undefined ? 'hello' : given.body
  const turn = given.turn === undefined ? 1 : given.turn
  const signalled = given.from !== undefined || given.cue !== undefined
  const body = {
    threadId,
    idempotencyKey: key,
    delivery: signalled
      ? {
          _tag: 'Signal' as const,
          envelope: {
            from: given.from === undefined ? 'Ada' : given.from,
            turn,
            cue: given.cue === undefined ? SignalCue.cases.Message.make({ body: words }) : given.cue,
          },
        }
      : {
          _tag: 'Words' as const,
          body: words,
          attachments: given.attachments === undefined ? [] : given.attachments,
        },
    turn,
    scope: { acting: given.acting === undefined ? creator : given.acting, libraryFolder: null },
    initialData: { creator, creatorName: 'Ada' },
  }
  return given.clientKey === undefined ? body : { ...body, clientKey: given.clientKey }
}

export const threadPath = (person: PersonId, threadId: string) =>
  `/persons/${person}/threads/${threadId}`

/** Admit a delivery and read its receipt; anything but 202 fails the case with the answer it got. */
export const admit = Effect.fn('RuntimeRequests.admit')(function* (
  runtime: Runtime,
  person: PersonId,
  body: ReturnType<typeof delivery>,
) {
  const response = yield* runtime.send(threadPath(person, body.threadId), { method: 'POST', body })
  expect(response).toMatchObject({ status: 202 })
  return yield* decodeReceipt(response.body)
})

/** The runtime's own wait: the request is held until the submission settles. No timer runs under the test clock. */
export const settled = Effect.fn('RuntimeRequests.settled')(function* (
  runtime: Runtime,
  person: PersonId,
  threadId: string,
  id: RuntimeSubmissionId,
) {
  const response = yield* runtime.send(`${threadPath(person, threadId)}/submissions/${id}`, {
    method: 'GET',
  })
  expect(response.status).toBe(200)
  return yield* decodeSettlement(response.body)
})

export const scenario = <A, E>(
  body: (given: World, runtime: Runtime) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const given = yield* world()
      return yield* body(given, yield* start(given))
    }),
  )
