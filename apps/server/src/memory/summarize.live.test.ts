import { layer } from '@effect/vitest'
import { Memory, MemoryId, MemoryScope, PersonId, PersonSummary } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect } from 'vitest'
import { MemoryExtraction, memoryExtractionLayer } from './extract.js'

const enabled =
  process.env['VIVID_LIVE_MEMORY'] === '1' &&
  (process.env['EXPLABS_API_KEY'] !== undefined || process.env['OPENROUTER_API_KEY'] !== undefined)
/** One real brief generation checks observable preference coverage and the bounded word budget. */
describe.skipIf(!enabled)('Memory brief generation', () => {
  layer(memoryExtractionLayer.pipe(Layer.provide(NodeHttpClient.layerUndici)), {
    excludeTestServices: true,
  })((it) => {
    it.effect(
      'summarizes current preferences within 600 words',
      () =>
        Effect.gen(function* () {
          const extraction = yield* MemoryExtraction
          const person = PersonSummary.make({ id: PersonId.make('A'), name: 'Dami', image: null })
          const memory = Memory.make({
            id: MemoryId.make('brief-preference'),
            kind: 'preference',
            content: 'Dami prefers meetings before 10 in the morning and concise written updates.',
            scope: MemoryScope.cases.Person.make({}),
            learnedIn: null,
            learnedFrom: person,
            createdAt: 0,
            updatedAt: 0,
          })
          // Independently varied workstreams exceed the output budget; a return-all summary
          // fails while the enduring working preference must remain represented.
          const workstreams = Array.from({ length: 40 }, (_, index) =>
            Memory.make({
              ...memory,
              id: MemoryId.make(`workstream-${index}`),
              kind: 'workstream',
              content: `Project ${index + 100} is preparing its regional launch. Dami reviews the supplier contract, checks the delivery calendar, assigns the support rota, compares vendor prices, confirms training dates and collects customer ratings from customers before approving the final release.`,
            }),
          )
          const text = yield* extraction.summarize({ memories: [memory, ...workstreams], person })
          expect(text).toMatch(/Dami/)
          expect(text).toMatch(/before 10|morning/)
          expect(text).toMatch(/concise/)
          expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(600)
        }),
      { timeout: 120000 },
    )
  })
})
