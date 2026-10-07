import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { NativeProof, nativeProofAvailable, nativeProofLayer } from '../../scripts/native.ts'

const passed = 'Vivid native pages proof passed'
if (!nativeProofAvailable) console.warn('Skipping native pages: xvfb-run is absent')
/** Native constructors, capture denial, popups and zoom are exercised in a disposable real client. */
describe.skipIf(!nativeProofAvailable)('Native desktop pages', () => {
  layer(nativeProofLayer({ script: 'pages.ts', ready: 'Vivid native pages ready', passed }), {
    excludeTestServices: true,
  })((it) => {
    it.effect(
      'retains views, revokes stale geometry, routes popups and zoom, and caps native guests',
      () =>
        Effect.gen(function* () {
          const result = yield* (yield* NativeProof).run
          expect(result.output).toContain(passed)
        }),
    )
  })
})
