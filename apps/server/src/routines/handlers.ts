import * as Effect from 'effect/Effect'
import {
  NotFound,
  Conflict,
  InvalidRequest,
  OccurrenceResponse,
  RoutineListResponse,
  RoutineResponse,
  RoutineTrigger,
  Workspace,
  type RoutineId,
  type FindEventsRequest,
  type CreateRoutineRequest,
  type CreateOnceRoutineRequest,
  type PatchRoutineRequest,
  type RoutineParams,
} from '@vivid/contracts'
import { requireActor, requirePerson, type Actor } from '../auth/access.ts'
import { standingRoutine } from '@vivid/skills'
import { Option } from 'effect'
import { changed } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { THREAD_OPENING_FAILURE } from './attempts.ts'
import { RoutineScheduler } from './scheduler.ts'
import { RoutineStore, type RoutineMissing } from './store.ts'
import { resolveLocal, type RoutineTimePassed, type InvalidRoutineSchedule } from './timing.ts'
import { SettingsStore } from '../settings/store.ts'

/** Internal validation failures become the fixed public RPC errors without exposing ownership. */
const missing = () => new NotFound({ message: 'Routine not found' })
const webhookRequired = () => new InvalidRequest({ message: 'Routine must use a webhook trigger' })
const invalidSchedule = (error: InvalidRoutineSchedule) =>
  new InvalidRequest({ message: error.message })

/** List and Watch use one owner-scoped loader, including when the live workspace changes. */
const loadRoutines = Effect.fn('Rpc.loadRoutines')(function* (actor: Actor) {
  const settings = yield* (yield* SettingsStore).get(actor.person.id)
  return RoutineListResponse.make({
    routines: yield* (yield* RoutineStore).list(actor),
    templates: [
      {
        name: standingRoutine.name,
        prompt: standingRoutine.prompt,
        trigger: RoutineTrigger.cases.Schedule.make({
          cron: standingRoutine.cron,
          timezone: settings.timezone,
        }),
      },
    ],
  })
})

/** Resolves the store's concealed absence into the shared transport failure. */
const concealMissing = <A, E, R>(effect: Effect.Effect<A, E | RoutineMissing, R>) =>
  effect.pipe(Effect.catchTag('RoutineMissing', () => Effect.fail(missing())))

/** Watch failures are readable setup refusals, without revealing private Connection identity. */
const integrationFailure = <A, R>(
  effect: Effect.Effect<
    A,
    | NotFound
    | Conflict
    | InvalidRequest
    | import('@vivid/contracts').Forbidden
    | InvalidRoutineSchedule
    | RoutineTimePassed
    | import('@vivid/contracts').ServiceUnavailable
    | import('../database/client.ts').DatabaseInfrastructureError
    | import('./watch.ts').WatchFailure,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      IntegrationRevoked: () =>
        Effect.fail(
          new InvalidRequest({ message: 'Reconnect this Integration before watching it.' }),
        ),
      IntegrationReadFailed: () =>
        Effect.fail(
          new InvalidRequest({
            message: 'The Integration could not return the configured ordered list.',
          }),
        ),
      IntegrationCursorLost: () =>
        Effect.fail(
          new InvalidRequest({ message: 'The Integration observation window was exceeded.' }),
        ),
    }),
  )

/** Both creation entry points use the same trigger validation and publication ordering. */
const createRoutine = Effect.fn('Rpc.CreateRoutine')(function* (
  request: typeof CreateRoutineRequest.Type,
) {
  let actor = yield* requireActor()
  // The built-in watch is always a personal commitment and needs an explicit signed-in action.
  // The model may run its procedure later, but cannot silently opt its Person into standing checks.
  if (request.prompt === standingRoutine.prompt) {
    const auth = yield* requirePerson()
    actor = {
      person: auth.person,
      workspace: Workspace.cases.Personal.make({}),
      by: 'person',
      threadId: Option.none(),
    }
  }
  const routine = yield* integrationFailure(
    concealMissing((yield* RoutineStore).create(actor, request)),
  ).pipe(
    Effect.catchTags({
      InvalidRoutineSchedule: (error) => Effect.fail(invalidSchedule(error)),
      RoutineTimePassed: () =>
        Effect.fail(new InvalidRequest({ message: 'A one-off Routine must be in the future.' })),
    }),
  )
  yield* changed(actor)
  return RoutineResponse.make({ routine })
})

export const routineHandlers = {
  /** Discovery resolves account names under exactly the same acting Person as creation. */
  FindEvents: Effect.fn('Rpc.FindEvents')(function* (request: typeof FindEventsRequest.Type) {
    return yield* (yield* RoutineStore).findEvents(yield* requireActor(), request.account)
  }),
  /** Both a Person and Vivid acting for them see precisely their own Routines. */
  ListRoutines: Effect.fn('Rpc.ListRoutines')(function* () {
    return yield* loadRoutines(yield* requireActor())
  }),
  /** Live reads reuse the loader and follow the signed-in Person’s current workspace. */
  WatchRoutines: () => live(loadRoutines),
  /** Creation validates and persists the trigger before publishing. */
  CreateRoutine: createRoutine,
  /** Wall-clock input is resolved with server-owned Settings, never a model-supplied epoch or zone. */
  CreateOnceRoutine: Effect.fn('Rpc.CreateOnceRoutine')(function* (
    request: typeof CreateOnceRoutineRequest.Type,
  ) {
    const actor = yield* requireActor()
    const settings = yield* (yield* SettingsStore).get(actor.person.id)
    const trigger = yield* resolveLocal(request.localAt, settings.timezone).pipe(
      Effect.catchTag('InvalidRoutineSchedule', (error) => Effect.fail(invalidSchedule(error))),
    )
    return yield* createRoutine({
      name: request.name,
      prompt: request.prompt,
      trigger,
    })
  }),
  /** Owner authorization and concurrent partial update semantics belong to persistence. */
  PatchRoutine: Effect.fn('Rpc.PatchRoutine')(function* ({
    id,
    patch,
  }: {
    readonly id: RoutineId
    readonly patch: typeof PatchRoutineRequest.Type
  }) {
    const actor = yield* requireActor()
    const routine = yield* integrationFailure(
      concealMissing((yield* RoutineStore).patch(actor, id, patch)),
    ).pipe(
      Effect.catchTags({
        InvalidRoutineSchedule: (error) => Effect.fail(invalidSchedule(error)),
        RoutineTimePassed: () =>
          Effect.fail(new InvalidRequest({ message: 'A one-off Routine must be in the future.' })),
      }),
    )
    yield* changed(actor)
    return RoutineResponse.make({ routine })
  }),
  /** Successful deletion refreshes every live view of the owner's workspace. */
  DeleteRoutine: Effect.fn('Rpc.DeleteRoutine')(function* ({ id }: typeof RoutineParams.Type) {
    const actor = yield* requireActor()
    yield* concealMissing((yield* RoutineStore).remove(actor, id))
    yield* changed(actor)
  }),
  /** Manual work uses the same delivery ordering as scheduled and webhook work. */
  RunRoutine: Effect.fn('Rpc.RunRoutine')(function* ({ id }: typeof RoutineParams.Type) {
    const actor = yield* requireActor()
    const run = yield* concealMissing((yield* RoutineScheduler).run(actor, id)).pipe(
      Effect.catchTag('RoutineThreadUnavailable', () =>
        Effect.fail(new Conflict({ message: THREAD_OPENING_FAILURE })),
      ),
    )
    yield* changed(actor)
    return OccurrenceResponse.make({ run })
  }),
  /** Rotation returns a redacted key once and invalidates the previous credential. */
  IssueRoutineWebhook: Effect.fn('Rpc.IssueRoutineWebhook')(function* ({
    id,
  }: {
    readonly id: RoutineId
  }) {
    const actor = yield* requireActor()
    const webhook = yield* concealMissing((yield* RoutineStore).issueWebhook(actor, id)).pipe(
      Effect.catchTag('RoutineWebhookRequired', () => Effect.fail(webhookRequired())),
    )
    yield* changed(actor)
    return webhook
  }),
}
