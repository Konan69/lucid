import { Clock, Config, Effect, Layer } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import { paceOnce } from '../../src/feed/pace.ts'
import { testDatabaseLayer } from '../../src/database/testdb.ts'
import { workLayer } from '../../src/database/work.ts'
import { changesLayer } from '../../src/live/changes.ts'
import { presenceLayer } from '../../src/threads/presence.ts'
import { pushTargetsLayer } from '../../src/push/targets.ts'

const data = workLayer.pipe(Layer.provideMerge(testDatabaseLayer))
const changes = changesLayer.pipe(Layer.provideMerge(data))
const services = Layer.mergeAll(presenceLayer, pushTargetsLayer).pipe(Layer.provideMerge(changes))

/**
 * verify-vivid's clock adapter for the production pacer, over its Launch-owned disposable DB.
 * SQL and queue resources acquire with live time. Only the pacing call gets controlled time;
 * the full model and Watch journeys run on the real server before this process is called.
 * No browser is open in the recipe, so the real Presence service has no holds.
 */
const program = Effect.gen(function* () {
  const at = yield* Config.Number('VIVID_VERIFY_PACING_AT')
  const live = Clock.Clock.defaultValue()
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => at,
    currentTimeMillis: Effect.succeed(at),
    currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  }
  yield* paceOnce().pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off -- This executable proof entry owns the service Layer and its scope.
  Effect.provide(services),
  Effect.scoped,
)

NodeRuntime.runMain(program)
