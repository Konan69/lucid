import { Clock, Effect, Option, Result } from 'effect'
import {
  ComputerHealth,
  DatabaseFailure,
  DatabaseUnavailable,
  DatabaseConstraintViolation,
  type PersonId,
  ComputerLifecycle,
  ComputerProbe,
  ComputerProbeFailure,
  ComputerProbeObservation,
  ComputerProbeResult,
  type ComputerHealthDepth,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { egressChosen } from './egress/setting.ts'
import type { ComputerAuthority } from './store.ts'
import {
  MachineAuthenticationFailed,
  MachineCreationUnresolved,
  MachineExecutionUnknown,
  MachineLifecycleStalled,
  MachineNoCapacity,
  MachineOutgrown,
  MachineResponseInvalid,
  MachineUnreachable,
  type MachineFailure,
} from './machine.ts'

/** Provider failures retain their closed meaning, with no provider body or identifier on the wire. */
export function probeFailure(failure: MachineFailure): ComputerProbeFailure {
  if (failure instanceof MachineUnreachable)
    return ComputerProbeFailure.cases.ProviderUnreachable.make({})
  if (failure instanceof MachineAuthenticationFailed)
    return ComputerProbeFailure.cases.ProviderAuthentication.make({})
  if (failure instanceof MachineCreationUnresolved)
    return ComputerProbeFailure.cases.BindingUnresolved.make({})
  if (failure instanceof MachineExecutionUnknown)
    return ComputerProbeFailure.cases.ReceiptLost.make({})
  if (failure instanceof MachineLifecycleStalled)
    return ComputerProbeFailure.cases.ProviderStalled.make({})
  if (failure instanceof MachineNoCapacity)
    return failure.limited
      ? ComputerProbeFailure.cases.ProviderStartLimit.make({})
      : ComputerProbeFailure.cases.ProviderCapacity.make({})
  if (failure instanceof MachineOutgrown)
    return ComputerProbeFailure.cases.ProviderOutgrown.make({ upgrade: failure.upgrade })
  if (failure instanceof MachineResponseInvalid)
    return ComputerProbeFailure.cases.InvalidObservation.make({})
  return ComputerProbeFailure.cases.ProviderRefused.make({})
}

/** Shared projection makes shallow reads passive and leaves lifecycle distinct from deep health. */
const computerHealth = Effect.fn('Computer.health')(function* (input: {
  readonly state: ComputerLifecycle
  readonly heldByPerson: boolean
  readonly depth: ComputerHealthDepth
  readonly probe: Effect.Effect<ReadonlyArray<ComputerProbe>, MachineFailure>
}) {
  const checkedAt = yield* Clock.currentTimeMillis
  if (input.heldByPerson) return ComputerHealth.cases.Held.make({ checkedAt })
  return yield* ComputerLifecycle.match<Effect.Effect<ComputerHealth, MachineFailure>>(
    input.state,
    {
      Absent: () => Effect.succeed(ComputerHealth.cases.Absent.make({ checkedAt })),
      Stopped: () => Effect.succeed(ComputerHealth.cases.Sleeping.make({ checkedAt })),
      Starting: ({ since }) =>
        Effect.succeed(ComputerHealth.cases.Starting.make({ checkedAt, since })),
      Failed: () =>
        Effect.succeed(
          ComputerHealth.cases.Unavailable.make({
            checkedAt,
            cause: ComputerProbeFailure.cases.RecordedFailure.make({}),
          }),
        ),
      Running: () =>
        Effect.gen(function* () {
          const provider = ComputerProbe.make({
            component: 'Provider',
            result: ComputerProbeResult.cases.Passed.make({
              observed: ComputerProbeObservation.cases.Responsive.make({}),
            }),
          })
          const probes =
            input.depth === 'Shallow' ? [provider] : [provider, ...(yield* input.probe)]
          if (probes.some((probe) => ComputerProbeResult.guards.Failed(probe.result)))
            return ComputerHealth.cases.Degraded.make({ checkedAt, probes })
          // Unsupported/downstream-skipped probes cannot certify Ready. Degraded also requires a
          // real failure, so an incomplete adapter answers Unavailable rather than inventing one.
          if (
            input.depth === 'Deep' &&
            probes.some(
              (probe) =>
                ComputerProbeResult.guards.NotRun(probe.result) &&
                probe.result.reason !== 'BrowserNotStarted',
            )
          )
            return ComputerHealth.cases.Unavailable.make({
              checkedAt,
              cause: ComputerProbeFailure.cases.InvalidObservation.make({}),
            })
          return ComputerHealth.cases.Ready.make({ checkedAt, depth: input.depth, probes })
        }),
    },
  )
})

/** The Computer store delegates passive observations here; no viewer or activity path is used. */
export function healthOperations(input: {
  readonly state: ComputerAuthority
  readonly database: Database['Service']
}) {
  const { state, database } = input
  /** Viewer-free lifecycle observations reuse reconciliation without touching activity. */
  const inspect = Effect.fn('ComputerStore.inspect')(function* (person: PersonId) {
    const { computer, failure } = yield* state.observe(person)
    if (Option.isSome(failure)) return yield* failure.value
    return { state: computer.state, heldByPerson: computer.heldByPerson }
  })
  /** Deep diagnostics stay outside preparation and activity, and never invoke guest setup. */
  const health = Effect.fn('ComputerStore.health')(function* (
    person: PersonId,
    depth: ComputerHealthDepth,
  ): Effect.fn.Return<ComputerHealth, DatabaseInfrastructureError> {
    const observed = yield* inspect(person).pipe(Effect.result)
    if (Result.isFailure(observed)) {
      if (
        observed.failure instanceof DatabaseFailure ||
        observed.failure instanceof DatabaseUnavailable ||
        observed.failure instanceof DatabaseConstraintViolation
      )
        return yield* observed.failure
      return ComputerHealth.cases.Unavailable.make({
        checkedAt: yield* Clock.currentTimeMillis,
        cause: probeFailure(observed.failure),
      })
    }
    const row = yield* state.rows.load(person)
    const egress =
      depth === 'Deep'
        ? yield* egressChosen(person).pipe(Effect.provideService(Database, database))
        : false
    return yield* computerHealth({
      ...observed.success,
      depth,
      probe: Option.match(row, {
        onNone: () => Effect.succeed([]),
        onSome: (value) => state.machine.health({ key: value.machine, egress }),
      }),
    }).pipe(
      Effect.catch((failure) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((checkedAt) =>
            ComputerHealth.cases.Unavailable.make({ checkedAt, cause: probeFailure(failure) }),
          ),
        ),
      ),
    )
  })
  return { inspect, health }
}
