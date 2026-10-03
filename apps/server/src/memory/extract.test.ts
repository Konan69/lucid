import { it } from '@effect/vitest'
import { Memory, MemoryId, MemoryScope, PersonId, PersonSummary, ThreadId } from '@vivid/contracts'
import { Effect } from 'effect'
import { expect } from 'vitest'
import {
  candidatesWithKnownRelations,
  MemoryCandidate,
  MemoryRelation,
  shownExchange,
  shownKnown,
  shownMemory,
  WrittenRelation,
  type WrittenCandidate,
} from './extract.js'

const dami = PersonSummary.make({ id: PersonId.make('person-a'), name: 'Dami', image: null })

const known = Memory.make({
  id: MemoryId.make('memory-known'),
  kind: 'fact',
  content: 'Dami works on launch planning.',
  scope: MemoryScope.cases.Thread.make({ threadId: ThreadId.make('thread-7'), title: 'Launch' }),
  learnedIn: ThreadId.make('thread-7'),
  learnedFrom: dami,
  createdAt: 1,
  updatedAt: 1,
})

const written = (relation: WrittenCandidate['relation']): WrittenCandidate => ({
  shouldStore: true,
  content: 'Dami prefers written updates.',
  kind: 'preference',
  aliases: [],
  relation,
  forCompany: false,
})

/** A made-up handle rejects one candidate without failing an otherwise useful extraction. */
it.effect('resolves a handle to the memory it stands for and drops one that names nothing', () =>
  Effect.sync(() => {
    const fresh = written(WrittenRelation.cases.new.make({}))
    const related = written(WrittenRelation.cases.extends.make({ ref: 'm1' }))
    const invalid = written(WrittenRelation.cases.updates.make({ ref: 'm9' }))
    expect(candidatesWithKnownRelations([invalid, fresh, related], [known])).toEqual([
      MemoryCandidate.make({ ...fresh, relation: MemoryRelation.cases.new.make({}) }),
      MemoryCandidate.make({
        ...related,
        relation: MemoryRelation.cases.extends.make({ id: known.id }),
      }),
    ])
  }),
)

/**
 * The model is never handed an identifier. This is checked on the exact values sent to it, as
 * text, so a field added to a record later cannot slip one through unnoticed.
 */
it.effect('shows the model words and handles, and no identifier of any kind', () =>
  Effect.sync(() => {
    const sent = JSON.stringify({
      brief: shownMemory(known),
      known: shownKnown([known]),
      exchange: shownExchange({
        person: dami,
        message: 'Keep updates written.',
        reply: 'Noted.',
        previousReply: null,
        recent: [{ speaker: 'Ada', message: 'Morning meetings.', reply: 'Noted.' }],
      }),
    })
    for (const identifier of ['memory-known', 'thread-7', 'person-a']) {
      expect(sent).not.toContain(identifier)
    }
    expect(shownKnown([known])).toEqual([
      {
        ref: 'm1',
        kind: 'fact',
        content: 'Dami works on launch planning.',
        about: 'the Thread “Launch”',
      },
    ])
  }),
)
