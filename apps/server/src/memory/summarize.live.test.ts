import { it } from '@effect/vitest'
import { Memory, MemoryId, MemoryScope, PersonId, PersonSummary } from '@vivid/contracts'
import { Effect } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect } from 'vitest'
import { MemoryExtraction, memoryExtractionLayer } from './extract.js'

const enabled =
  process.env['VIVID_TEST_HELIX_URL'] !== undefined &&
  process.env['OPENROUTER_API_KEY'] !== undefined
/** One real brief generation checks observable preference coverage and the bounded word budget. */
describe.skipIf(!enabled)('Memory brief generation', () => {
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
        const text = yield* extraction.summarize({ memories: [memory], person })
        expect(text).toMatch(/Dami/)
        expect(text).toMatch(/morning|10/)
        expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(600)
      }).pipe(Effect.provide(memoryExtractionLayer), Effect.provide(NodeHttpClient.layerUndici)),
    { timeout: 120000 },
  )
})
