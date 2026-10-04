import {
  Memory,
  MemoryId,
  MemoryNoteScope,
  MemoryScope,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { describe, expect, it } from 'vitest'
import { PAGE_BUDGET, pageOf } from './page.ts'

/** A stored fact of a chosen length; the page reads only kind, content and scope. */
const fact = (index: number, length: number) =>
  Memory.make({
    id: MemoryId.make(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    kind: 'fact',
    content: `${index}`.padEnd(length, 'x'),
    scope: MemoryScope.cases.Person.make({}),
    learnedIn: null,
    learnedFrom: { id: PersonId.make('person'), name: 'Ada', image: null },
    createdAt: index,
    updatedAt: index,
  })

/** A read that reached the end of what is stored. */
const read = (memories: ReadonlyArray<Memory>) => ({ memories, truncated: false })

describe('the memory page', () => {
  it('shows every fact as stored when they fit, in the order given', () => {
    const page = pageOf(read([fact(3, 20), fact(2, 20), fact(1, 20)]))
    expect(page.notes.map((note) => note.content.slice(0, 1))).toEqual(['3', '2', '1'])
    expect(page.older).toBe(false)
  })

  it('stops at the budget and says older facts were left out', () => {
    const page = pageOf(read([fact(4, 3000), fact(3, 3000), fact(2, 3000), fact(1, 10)]))
    // 3000 + 3000 fits in 8000; the third would pass it, and nothing older skips ahead of it.
    expect(page.notes).toHaveLength(2)
    expect(page.older).toBe(true)
  })

  it('still shows one fact that is longer than the whole budget', () => {
    const page = pageOf(read([fact(2, PAGE_BUDGET + 1), fact(1, 10)]))
    expect(page.notes).toHaveLength(1)
    expect(page.older).toBe(true)
  })

  it('is empty when nothing is stored', () => {
    expect(pageOf(read([]))).toEqual({ notes: [], older: false })
  })

  it('says older facts exist when the store read was cut short, even if every read fact fits', () => {
    expect(pageOf({ memories: [fact(1, 20)], truncated: true }).older).toBe(true)
  })

  it('names a shared Thread by its title and carries no identifier', () => {
    const shared = Memory.make({
      ...fact(1, 20),
      scope: MemoryScope.cases.Thread.make({
        threadId: ThreadId.make('thread-7'),
        title: 'Launch',
      }),
    })
    expect(pageOf(read([shared])).notes.map((note) => note.scope)).toEqual([
      MemoryNoteScope.cases.Thread.make({ title: 'Launch' }),
    ])
  })
})
