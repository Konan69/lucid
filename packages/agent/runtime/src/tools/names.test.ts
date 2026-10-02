import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
import { distinct, inventory, named, NameAmbiguous, NameMissing } from './names.ts'

/** Returned names must round-trip to the same records, including case variants and literal suffixes. */
describe('human names', () => {
  it('numbers repeats in stable list order and reserves literal suffixes', () => {
    expect(distinct(['Draft', 'Draft', 'draft'])).toEqual(['Draft', 'Draft (2)', 'draft (3)'])
    const items = ['Draft', 'Draft', 'Draft (2)', 'draft', 'Draft (3)']
    const entries = inventory(items, (item) => item)
    expect(new Set(entries.map((entry) => entry.name.toLowerCase())).size).toBe(items.length)
    for (const entry of entries)
      expect(named(entries, ` ${entry.name.toUpperCase()} `)).toEqual(Result.succeed(entry.item))
  })
  it('never makes a fuzzy or ambiguous selection', () => {
    const entries = [
      { name: 'Draft', item: 1 },
      { name: 'draft', item: 2 },
    ]
    expect(named(entries, 'Dra')).toEqual(Result.fail(new NameMissing({ name: 'Dra' })))
    expect(named(entries, ' DRAFT ')).toEqual(
      Result.fail(new NameAmbiguous({ name: 'DRAFT', matches: ['Draft', 'draft'] })),
    )
  })
})
