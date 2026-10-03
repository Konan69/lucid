import { expect, it } from '@effect/vitest'
import { Service, ServiceAuthorization, ServiceId } from '@vivid/contracts'
import { Array as Arr, Effect, Order, Schema } from 'effect'
import data from './curation.json' with { type: 'json' }
import { coversCatalog, curatedSearch, CurationDocument } from './curation.ts'

const decodeCuration = Schema.decodeUnknownEffect(CurationDocument)

/** Catalogue hints deliberately remain optimistic; curation must correct them without probing. */
function service(entry: (typeof CurationDocument.Type.entries)[number]): Service {
  return Service.make({
    id: entry.id,
    name: entry.name,
    description: entry.why,
    mark: null,
    authorization: ServiceAuthorization.cases.SignIn.make({}),
  })
}

it.effect(
  'covers every catalogue identity and name; missing, renamed and new entries require review',
  () =>
    Effect.gen(function* () {
      const document = yield* decodeCuration(data)
      expect(document.catalog).toHaveLength(3586)
      expect(document.entries).toHaveLength(document.catalog.length)
      expect(coversCatalog(document, document.catalog)).toBe(true)
      const incomplete = { ...document, entries: document.entries.slice(1) }
      expect(coversCatalog(incomplete, document.catalog)).toBe(false)
      const renamed = document.catalog.map((entry, index) =>
        index === 0 ? { ...entry, name: 'Renamed mailbox' } : entry,
      )
      expect(coversCatalog(document, renamed)).toBe(false)
      expect(
        coversCatalog(document, [
          ...document.catalog,
          { id: ServiceId.make('new/service'), name: 'Unreviewed service' },
        ]),
      ).toBe(false)
    }),
)

it.effect(
  'defaults to Core then Useful, keeps explicit popularity order and counts reachable tiers',
  () =>
    Effect.gen(function* () {
      const document = yield* decodeCuration(data)
      const find = curatedSearch(document)
      const found = find(Arr.reverse(document.entries.map(service)), ' \t ')
      expect(found.services.map((entry) => entry.name).slice(0, 9)).toEqual([
        'Gmail',
        'Google Calendar',
        'Google Drive',
        'Google Docs',
        'Google Sheets',
        'Outlook Mail',
        'Outlook Calendar',
        'Slack',
        'Notion',
      ])
      expect(found.services).toHaveLength(24)
      expect(found.total).toBe(document.entries.filter((entry) => entry.tier !== 'Hide').length)
      const tierById = new Map(document.entries.map((entry) => [entry.id, entry.tier]))
      expect(found.services.every((entry) => tierById.get(entry.id) === 'Core')).toBe(true)
      expect(find(document.entries.map(service), 'Unmatched catalogue search').total).toBe(
        found.total,
      )
    }),
)

it.effect(
  'searches Niche after Core and Useful; hidden duplicates require their complete name',
  () =>
    Effect.gen(function* () {
      const document = yield* decodeCuration(data)
      const find = curatedSearch(document)
      const services = document.entries.map(service)
      const hidden = ServiceId.make('openapi/zoom-us')
      expect(find(services, 'zoom').services.map((entry) => entry.id)).not.toContain(hidden)
      const exact = find(services, '  ZOOM API  ')
      expect(exact.services.map((entry) => entry.id)).toContain(hidden)
      expect(exact.services[0]).toMatchObject({ curation: { worksNow: false } })
      const niche = find(services, 'Ramp')
      expect(niche.services.map((entry) => entry.name)).toEqual(['Ramp'])
      expect(find(services, '').services.map((entry) => entry.name)).not.toContain('Ramp')
      const google = find(services, 'google')
      const tierById = new Map(document.entries.map((entry) => [entry.id, entry.tier]))
      const tiers = google.services.map((entry) => tierById.get(entry.id))
      const ranks = tiers.map((tier) => ['Core', 'Useful', 'Niche'].indexOf(String(tier)))
      expect(ranks.every((rank) => rank >= 0)).toBe(true)
      expect(ranks).toEqual(Arr.sort(ranks, Order.Number))
    }),
)

it.effect(
  'reports configured Google separately from operator setup and never guesses missing auth',
  () =>
    Effect.gen(function* () {
      const document = yield* decodeCuration(data)
      const find = curatedSearch(document)
      const services = document.entries.map(service)
      const gmail = find(services, 'Gmail')
      expect(gmail.services[0]).toMatchObject({
        curation: { kind: 'mail', auth: 'OneTap', worksNow: true },
      })
      const slack = find(services, 'Slack')
      expect(slack.services[0]).toMatchObject({
        authorization: ServiceAuthorization.cases.SetupRequired.make({}),
        curation: { auth: 'OperatorSetup', worksNow: false },
      })
      const outlook = find(services, 'Outlook Mail')
      expect(outlook.services[0]).toMatchObject({
        authorization: ServiceAuthorization.cases.SetupRequired.make({}),
        curation: { kind: 'mail', auth: 'OperatorSetup', worksNow: false },
      })
      const notion = find(services, 'Notion')
      expect(notion.services[0]).toMatchObject({
        curation: { kind: 'notes', auth: 'OneTap', worksNow: true },
      })
      const unavailable = services.map((entry) =>
        Service.make({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          mark: entry.mark,
          authorization: ServiceAuthorization.cases.SetupRequired.make({}),
        }),
      )
      expect(find(unavailable, 'Gmail').services[0]).toMatchObject({
        curation: { auth: 'OneTap', worksNow: false },
      })
    }),
)

it.effect(
  'finds an upstream entry with no judgement by name only, and never offers it unasked',
  () =>
    Effect.gen(function* () {
      const document = yield* decodeCuration(data)
      const find = curatedSearch(document)
      const unreviewed = Service.make({
        id: ServiceId.make('new/service'),
        name: 'New service',
        description: '',
        mark: null,
        authorization: ServiceAuthorization.cases.None.make({}),
      })
      const services = [...document.entries.map(service), unreviewed]
      expect(find(services, 'New service').services).toEqual([unreviewed])
      expect(find(services, '').services.map((entry) => entry.id)).not.toContain(unreviewed.id)
    }),
)
