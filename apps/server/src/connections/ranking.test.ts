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

it.effect(
  'puts common services first for empty searches and preserves the remaining catalog order',
  () =>
    Effect.sync(() => {
      const catalog = services([
        'Box',
        'Airtable',
        'Notion',
        'Slack',
        'Outlook',
        'Microsoft 365',
        'Google Drive',
        'Google Calendar',
        'Gmail',
        'Google Workspace',
        'Other',
      ])
      expect(rankServices(catalog, ' \t ').map((service) => service.name)).toEqual([
        'Google Workspace',
        'Gmail',
        'Google Calendar',
        'Google Drive',
        'Microsoft 365',
        'Outlook',
        'Slack',
        'Notion',
        'Box',
        'Airtable',
        'Other',
      ])
      expect(rankServices(catalog, 'o').map((service) => service.name)).toEqual([
        'Outlook',
        'Other',
        'Box',
        'Notion',
        'Microsoft 365',
        'Google Drive',
        'Google Calendar',
        'Google Workspace',
      ])
    }),
)

it.effect('recognizes exact common-service names without promoting lookalikes', () =>
  Effect.sync(() => {
    const catalog = services([
      'Box',
      'Google Workspace Helper',
      'NOTION',
      'Drive',
      'Microsoft Outlook',
    ])
    expect(rankServices(catalog, '').map((service) => service.name)).toEqual([
      'Drive',
      'Microsoft Outlook',
      'NOTION',
      'Box',
      'Google Workspace Helper',
    ])
  }),
)

it.effect('keeps common services ahead of the rest even when operator setup is required', () =>
  Effect.sync(() => {
    const catalog = services(['Box', 'Gmail', 'Google Workspace', 'Gmail'])
    const firstGmail = catalog[1]
    if (firstGmail === undefined) expect.fail('Expected Gmail fixture')
    const entries = catalog.map((entry) =>
      entry === firstGmail
        ? Service.make({
            ...entry,
            authorization: ServiceAuthorization.cases.SetupRequired.make({}),
          })
        : entry,
    )
    expect(rankServices(entries, '').map((entry) => entry.id)).toEqual([
      'service-2',
      'service-3',
      firstGmail.id,
      'service-0',
    ])
  }),
)

it.effect(
  'puts setup-required services last within each name rank and throughout the empty query',
  () =>
    Effect.sync(() => {
      const entries = services(['Records Disabled', 'Records Active', 'Records', 'Old Records'])
      const disabled = entries.map((service, index) =>
        Service.make({
          id: service.id,
          name: service.name,
          description: service.description,
          mark: service.mark,
          authorization:
            index === 0 || index === 2
              ? ServiceAuthorization.cases.SetupRequired.make({})
              : service.authorization,
        }),
      )
      expect(rankServices(disabled, 'records').map((service) => service.name)).toEqual([
        'Records',
        'Records Active',
        'Records Disabled',
        'Old Records',
      ])
      expect(rankServices(disabled, '').map((service) => service.name)).toEqual([
        'Records Active',
        'Old Records',
        'Records Disabled',
        'Records',
      ])
      const many = services(Array.from({ length: 30 }, (_, index) => `Service ${index}`)).map(
        (service, index) =>
          Service.make({
            id: service.id,
            name: service.name,
            description: service.description,
            mark: service.mark,
            authorization:
              index < 25
                ? ServiceAuthorization.cases.SetupRequired.make({})
                : service.authorization,
          }),
      )
      expect(rankServices(many, '').slice(0, 5)).toEqual(many.slice(25))
    }),
)
