import { it } from '@effect/vitest'
import { Memory, MemoryId, MemoryScope, PersonId, PersonSummary } from '@vivid/contracts'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { candidatesWithKnownRelations, MemoryCandidate, MemoryRelation } from './extract.js'

/** Invalid references reject one candidate without turning an otherwise useful exchange into a failed extraction. */
it.effect('retains new and known-related candidates while dropping unknown relation ids', () =>
  Effect.sync(() => {
    const known = Memory.make({
      id: MemoryId.make('known'),
      kind: 'fact',
      content: 'Dami works on launch planning.',
      scope: MemoryScope.cases.Person.make({}),
      learnedIn: null,
      learnedFrom: PersonSummary.make({ id: PersonId.make('A'), name: 'Dami', image: null }),
      createdAt: 1,
      updatedAt: 1,
    })
    const fresh = MemoryCandidate.make({
      shouldStore: true,
      content: 'Dami prefers written updates.',
      kind: 'preference',
      aliases: [],
      relation: MemoryRelation.cases.new.make({}),
      forCompany: false,
    })
    const related = MemoryCandidate.make({
      ...fresh,
      relation: MemoryRelation.cases.extends.make({ id: known.id }),
    })
    const invalid = MemoryCandidate.make({
      ...fresh,
      relation: MemoryRelation.cases.updates.make({ id: MemoryId.make('unknown') }),
    })
    expect(candidatesWithKnownRelations([invalid, fresh, related], [known])).toEqual([
      fresh,
      related,
    ])
  }),
)
