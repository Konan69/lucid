import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { NativeProof, nativeProofAvailable, nativeProofLayer } from '../../scripts/native.ts'

const passed = 'Vivid native control proof passed'

/**
 * Opt-in: `VIVID_TEST_DESKTOP_LIVE=1 pnpm --filter @vivid/desktop exec vitest run
 * src/main/driver.live.test.ts`. It needs the public internet (example.com, httpbin.org) and a
 * second real Electron under xvfb. Inside the push gate it ran beside the pages proof and every
 * other suite, and its Electron exited before the proof finished: it refused two pushes on
 * 4 October 2026 while passing every time it was run alone. A proof that depends on the network
 * and on machine load cannot decide whether code may be pushed, so it is run on purpose, like
 * the other live proofs.
 */
const live = nativeProofAvailable && process.env.VIVID_TEST_DESKTOP_LIVE === '1'

/**
 * The real executor inside real Electron against real pages (`scripts/control.ts`). Every other
 * desktop suite proves the same logic against a scripted Browser.
 */
describe.skipIf(!live)('Native desktop control', () => {
  layer(nativeProofLayer({ script: 'control.ts', ready: 'Vivid native control ready', passed }), {
    excludeTestServices: true,
  })((it) => {
    it.effect(
      'opens, reads, clicks, types, presses, captures, stops, refuses and links, for real',
      () =>
        Effect.gen(function* () {
          const result = yield* (yield* NativeProof).run()
          expect(result.output).toContain(passed)
        }),
      60_000,
    )
  })
})
