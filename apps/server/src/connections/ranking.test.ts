import { expect, it } from '@effect/vitest'
import { Service, ServiceAuthorization, ServiceId } from '@vivid/contracts'
import { Effect } from 'effect'
import { rankServices } from './ranking.ts'

/** Identical descriptions prove that only service names affect ranking. */
function services(names: readonly string[]) {
  return names.map((name, index) =>
    Service.make({
      id: ServiceId.make(`service-${index}`),
      name,
      description: 'Records',
      mark: null,
      authorization: ServiceAuthorization.cases.None.make({}),
    }),
  )
}

it.effect('ranks exact, prefix and substring names case-insensitively with stable ties', () =>
  Effect.sync(() => {
    const catalog = services([
      'My Records',
      'Records Two',
      'Unrelated',
      'Records',
      'Records One',
      'Old Records',
    ])
    expect(rankServices(catalog, '  RECORDS  ').map((service) => service.name)).toEqual([
      'Records',
      'Records Two',
      'Records One',
      'My Records',
      'Old Records',
    ])
    expect(rankServices(catalog, 'Unmatched')).toEqual([])
  }),
)

it.effect('returns the catalog head for whitespace and bounds every search to 24', () =>
  Effect.sync(() => {
    const catalog = services(Array.from({ length: 30 }, (_, index) => `Records ${index}`))
    expect(rankServices(catalog, ' \t ')).toEqual(catalog.slice(0, 24))
    expect(rankServices(catalog, 'Records')).toEqual(catalog.slice(0, 24))
    expect(rankServices([], '')).toEqual([])
    const unnamed = services(['First', '', 'Last'])
    expect(rankServices(unnamed, ' ')).toEqual(unnamed)
  }),
)
