import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Effect from 'effect/Effect'
import { admission } from './library/extraction/process.ts'

/** Refuse unsupported inherited Node flags before importing the application graph. Loading every
 * adapter first made configuration refusal compete with cold-start compilation and forced the
 * startup regression to raise its runner alarm. The same admission also protects every PDF fork. */
const launch = Effect.gen(function* () {
  yield* admission
  const { serverProgram } = yield* Effect.promise(() => import('./application.ts'))
  return yield* serverProgram
})

NodeRuntime.runMain(launch)
