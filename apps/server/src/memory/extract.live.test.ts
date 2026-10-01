import { it } from '@effect/vitest'
import { PersonId, PersonSummary } from '@vivid/contracts'
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import {
  MemoryExchange,
  MemoryExtraction,
  MemoryRelation,
  memoryExtractionLayer,
} from './extract.js'

const enabled =
  process.env['VIVID_TEST_HELIX_URL'] !== undefined &&
  process.env['OPENROUTER_API_KEY'] !== undefined
/** One real structured model call proves a short answer inherits its subject and stays private without Company intent. */
describe.skipIf(!enabled)('Contextual memory extraction', () => {
  it.effect(
    'resolves a short answer into a durable private preference',
    () =>
      Effect.gen(function* () {
        const extraction = yield* MemoryExtraction
        const exchange = MemoryExchange.make({
          person: PersonSummary.make({ id: PersonId.make('A'), name: 'Dami', image: null }),
          message: 'Mornings, before 10.',
          reply: 'I will remember that you prefer meetings before 10 in the morning.',
          previousReply: 'What time of day do you prefer for meetings?',
          recent: [],
        })
        const candidates = yield* extraction.extract({
          exchange,
          known: [],
          now: Date.UTC(2026, 9, 1),
        })
        const preferences = candidates.filter(
          (candidate) => candidate.shouldStore && candidate.kind === 'preference',
        )
        expect(preferences.length).toBeGreaterThan(0)
        expect(
          preferences.some(
            (candidate) => /Dami/.test(candidate.content) && /morning|10/.test(candidate.content),
          ),
        ).toBe(true)
        expect(preferences.every((candidate) => !candidate.forCompany)).toBe(true)
        expect(candidates.every((candidate) => MemoryRelation.guards.new(candidate.relation))).toBe(
          true,
        )
      }).pipe(Effect.provide(memoryExtractionLayer), Effect.provide(FetchHttpClient.layer)),
    { timeout: 120000 },
  )
})
