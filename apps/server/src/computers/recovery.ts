import { Clock, Effect, Option, Result } from 'effect'
import { and, eq } from 'drizzle-orm'
import {
  ComputerHealth,
  ComputerProbeResult,
  ComputerRecoveryOutcome as Outcome,
  ComputerRecoveryRefusal as Refusal,
  type RecoverComputerRequest,
  type ComputerRecoveryStep,
  type PersonId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import type { ComputerAuthority, ComputerStoreService } from './store.ts'
import { MachineRecovery, type MachineFailure } from './machine.ts'
import { computerRecoveries } from './tables.ts'

const unsupported = new Map<ComputerRecoveryStep, string>([
  ['Restore', 'No Person snapshot restore contract is available.'],
  ['RestartDesktop', 'The desktop session supervisor is not attested.'],
])
const encode = encodeStored(Outcome, 'Computer recovery outcome')
const decode = decodeStored(Outcome, 'Computer recovery outcome')
interface Authority {
  readonly state: ComputerAuthority
  readonly database: Database['Service']
  readonly health: ComputerStoreService['health']
  readonly wake: (
    person: PersonId,
  ) => Effect.Effect<
    void,
    | DatabaseInfrastructureError
    | MachineFailure
    | import('./store.ts').ComputerWakeTimedOut
    | import('./store.ts').ComputerStartFailed
    | import('./store.ts').ComputerNotReady
    | import('./store.ts').ComputerHeld
  >
}

/** A mutation is never retried after its receipt is lost, even when its transport error looks
 * transient. The caller has already persisted a claim before entering this boundary. */
const mutate = Effect.fn('ComputerRecovery.mutate')(function* (
  input: Authority,
  person: PersonId,
  request: RecoverComputerRequest,
  before: typeof ComputerHealth.cases.Degraded.Type,
) {
  const row = yield* input.state.rows.load(person)
  if (Option.isNone(row) || row.value.held)
    return Result.succeed(MachineRecovery.cases.Refused.make({}))
  if (request.step !== 'Reboot')
    return yield* input.state.machine
      .recover({ key: row.value.machine, step: request.step, probes: before.probes })
      .pipe(Effect.result)
  if (
    !before.probes.some(
      (probe) =>
        ['Ssh', 'Desktop', 'Driver'].includes(probe.component) &&
        ComputerProbeResult.guards.Failed(probe.result),
    )
  )
    return Result.succeed(MachineRecovery.cases.Refused.make({}))
  return yield* Effect.gen(function* () {
    yield* input.state.machine.stop(row.value.machine)
    yield* input.state.machine.ensure(row.value.machine)
    return MachineRecovery.cases.Applied.make({})
  }).pipe(Effect.result)
})

/** Both Person and Vivid calls share the same owner; Vivid additionally needs its current Run. */
const admitted = Effect.fn('ComputerRecovery.admitted')(function* (actor: Actor) {
  if (actor.by === 'person') return true
  const origin = yield* actionOrigin(actor).pipe(
    Effect.asSome,
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )
  return Option.isSome(origin) && ActionOrigin.guards.Run(origin.value)
})

/** The final Run, lifecycle and takeover checks happen under the existing action permit.
 * Wake waits outside it because its boot worker needs that same permit to finish. */
const step = (input: Authority) =>
  Effect.fn('ComputerRecovery.step')(
    function* (
      actor: Actor,
      request: RecoverComputerRequest,
    ): Effect.fn.Return<Outcome, DatabaseInfrastructureError> {
      const person = actor.person.id
      if (!(yield* admitted(actor).pipe(Effect.provideService(Database, input.database))))
        return Outcome.cases.Refused.make({ cause: Refusal.cases.RunRequired.make({}) })
      const before = yield* input.health(person, 'Deep')
      if (ComputerHealth.guards.Held(before))
        return Outcome.cases.Refused.make({ cause: Refusal.cases.Held.make({}) })
      const reason = unsupported.get(request.step)
      if (reason !== undefined)
        return Outcome.cases.Unsupported.make({ step: request.step, reason })
      if (ComputerHealth.guards.Ready(before))
        return Outcome.cases.Completed.make({ receipt: request.id, health: before })
      if (request.step === 'Wake') {
        if (!ComputerHealth.isAnyOf(['Absent', 'Sleeping', 'Starting'])(before))
          return Outcome.cases.Refused.make({ cause: Refusal.cases.WrongStep.make({}) })
        const awake = yield* input.wake(person).pipe(Effect.result)
        if (Result.isFailure(awake))
          return Outcome.cases.OutcomeUnknown.make({ receipt: request.id })
      } else {
        if (!ComputerHealth.guards.Degraded(before))
          return Outcome.cases.Refused.make({ cause: Refusal.cases.WrongStep.make({}) })
        const repaired = yield* mutate(input, person, request, before)
        if (Result.isFailure(repaired))
          return Outcome.cases.OutcomeUnknown.make({ receipt: request.id })
        const refusal = MachineRecovery.match<Option.Option<Outcome>>(repaired.success, {
          Applied: () => Option.none(),
          Unsupported: ({ reason: unavailable }) =>
            Option.some(
              Outcome.cases.Unsupported.make({ step: request.step, reason: unavailable }),
            ),
          Refused: () =>
            Option.some(Outcome.cases.Refused.make({ cause: Refusal.cases.WrongStep.make({}) })),
        })
        if (Option.isSome(refusal)) return refusal.value
      }
      return Outcome.cases.Completed.make({
        receipt: request.id,
        health: yield* input.health(person, 'Deep'),
      })
    },
    (effect, actor, request) =>
      request.step === 'Wake' ? effect : input.state.lock.withPermit(actor.person.id, effect),
  )

/** SQL owns at-most-once dispatch across restarts. Effect Workflow Activity can repeat an
 * external effect before its exit is stored; these supervisor calls have no remote dedupe key.
 * A claimed row without a completion therefore stays OutcomeUnknown, never replayed. */
export function computerRecovery(input: Authority) {
  const run = step(input)
  return Effect.fn('ComputerStore.recover')(function* (
    actor: Actor,
    request: RecoverComputerRequest,
  ) {
    const person = actor.person.id
    const database = input.database
    const [claimed] = yield* database.run(
      database
        .insert(computerRecoveries)
        .values({
          id: request.id,
          personId: person,
          step: request.step,
          createdAt: yield* Clock.currentTimeMillis,
        })
        .onConflictDoNothing()
        .returning({ id: computerRecoveries.id }),
    )
    if (claimed === undefined) {
      const [old] = yield* database.run(
        database
          .select()
          .from(computerRecoveries)
          .where(
            and(eq(computerRecoveries.id, request.id), eq(computerRecoveries.personId, person)),
          ),
      )
      if (old === undefined || old.personId !== person || old.step !== request.step)
        return Outcome.cases.Refused.make({ cause: Refusal.cases.KeyReused.make({}) })
      return old.outcome === null
        ? Outcome.cases.OutcomeUnknown.make({ receipt: request.id })
        : yield* decode(old.outcome)
    }
    const outcome = yield* run(actor, request)
    yield* database.run(
      database
        .update(computerRecoveries)
        .set({ outcome: yield* encode(outcome) })
        .where(and(eq(computerRecoveries.id, request.id), eq(computerRecoveries.personId, person))),
    )
    return outcome
  })
}
