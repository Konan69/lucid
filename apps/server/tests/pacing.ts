import { Clock, Config, Effect, Layer } from 'effect'
import { NodeRuntime } from '@effect/platform-node'
import { paceOnce } from '../src/feed/pace.ts'
import { testDatabaseLayer } from '../src/database/testdb.ts'
import { workLayer } from '../src/database/work.ts'
import { changesLayer } from '../src/live/changes.ts'
import { presenceLayer } from '../src/threads/presence.ts'
import { pushTargetsLayer } from '../src/push/targets.ts'

/**
 * verify-vivid's clock adapter for the production pacer, over its Launch-owned disposable DB.
 * SQL and queue resources acquire with live time. Only the pacing call gets controlled time;
 * the full model and Watch journeys run on the real server before this process is called.
 * No browser is open in the recipe, so the real Presence service has no holds.
 */
const program = Effect.gen(function* () {
  const at = yield* Config.number('VIVID_VERIFY_PACING_AT')
  const data = workLayer.pipe(Layer.provideMerge(testDatabaseLayer))
  const changes = changesLayer.pipe(Layer.provideMerge(data))
  const services = Layer.mergeAll(presenceLayer, pushTargetsLayer).pipe(Layer.provideMerge(changes))
  const live = Clock.Clock.defaultValue()
  const clock = {
    ...live,
    currentTimeMillisUnsafe: () => at,
    currentTimeMillis: Effect.succeed(at),
  }
  yield* paceOnce().pipe(Effect.provideService(Clock.Clock, clock), Effect.provide(services))
}).pipe(Effect.scoped)

NodeRuntime.runMain(program)
