import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { NativeProof, nativeProofAvailable, nativeProofLayer } from '../../scripts/native.ts'

const passed = 'Vivid native control proof passed'
if (!nativeProofAvailable) console.warn('Skipping native control: xvfb-run is absent')

/**
 * The real executor inside real Electron against real pages (`scripts/control.ts`). It needs the
 * public internet, so it is the one desktop suite whose result depends on the network; every
 * other suite proves the same logic against a scripted Browser.
 */
describe.skipIf(!nativeProofAvailable)('Native desktop control', () => {
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
