import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
import { SkillId } from '@vivid/contracts'
import { distinct, inventory, named, NameAmbiguous, NameMissing, savedInventory } from './names.ts'

/** Returned names must round-trip to the same records, including case variants and literal suffixes. */
describe('human names', () => {
  it('numbers repeats in stable list order and reserves literal suffixes', () => {
    expect(distinct(['Draft', 'Draft', 'draft'])).toEqual(['Draft', 'Draft (2)', 'draft (3)'])
    const items = ['Draft', 'Draft', 'Draft (2)', 'draft', 'Draft (3)'].map((name, index) => ({
      id: String(index),
      createdAt: index,
      name,
    }))
    const entries = inventory(items, (item) => item.name)
    expect(new Set(entries.map((entry) => entry.name.toLowerCase())).size).toBe(items.length)
    for (const entry of entries)
      expect(named(entries, ` ${entry.name.toUpperCase()} `)).toEqual(Result.succeed(entry.item))
  })
  it('retains duplicate identity when status, due time, updated time and list order change', () => {
    const first = { id: 'a', createdAt: 1, name: 'Draft', status: 'open', dueAt: 2, updatedAt: 1 }
    const second = { id: 'b', createdAt: 1, name: 'Draft', status: 'open', dueAt: 1, updatedAt: 2 }
    const shown = inventory([second, first], (item) => item.name)
    const changed = { ...first, status: 'done', dueAt: 4, updatedAt: 5 }
    const relisted = inventory([second, changed], (item) => item.name)
    expect(shown.map(({ name, item }) => [name, item.id])).toEqual([
      ['Draft', 'a'],
      ['Draft (2)', 'b'],
    ])
    for (const entry of shown) {
      const selected = named(relisted, entry.name)
      expect(Result.isSuccess(selected) && selected.success.id).toBe(entry.item.id)
    }
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

  it('keeps saved runtime labels distinct from built-ins and literal suffixes without losing legacy text', () => {
    const items = [
      'Deep research',
      'deep-research-saved',
      'DEEP RESEARCH',
      'Réviser le contrat',
      '审查',
    ].map((name, index) => ({ id: SkillId.make(`MARK-${index}`), createdAt: index, name }))
    const entries = savedInventory(items, (item) => item.name)
    expect(entries.map((entry) => entry.name)).toEqual([
      'deep-research-saved',
      'deep-research-saved-2',
      'deep-research-saved-3',
      'réviser-le-contrat',
      '审查',
    ])
    for (const entry of entries)
      expect(named(entries, entry.name)).toEqual(Result.succeed(entry.item))
  })
})
