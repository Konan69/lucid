import {
  Service,
  ServiceAuthorization,
  ServiceCatalog,
  ServiceCuration,
  ServiceId,
  ServiceUnavailable,
} from '@vivid/contracts'
import { Array as Arr, Effect, Match, Order, Schema } from 'effect'
import data from './curation.json' with { type: 'json' }
import { KeyedService } from './keyed.ts'

/** An independent build manifest makes dropped judgements detectable even when names repeat. */
const CatalogIdentity = Schema.Struct({ id: ServiceId, name: Schema.NonEmptyString })
const CurationEntry = Schema.Struct({
  ...CatalogIdentity.fields,
  tier: Schema.Literals(['Core', 'Useful', 'Niche', 'Hide']),
  ...ServiceCuration.fields,
  operator: Schema.NullOr(Schema.NonEmptyString),
  authScheme: Schema.NullOr(Schema.NonEmptyString),
  sourceKind: Schema.Literals(['openapi', 'mcp']),
  why: Schema.NonEmptyString,
  classifier: Schema.Literals(['Jev', 'Reviewed']),
})

/** The checked-in file owns the snapshot, every judgement and the single popularity list. */
export const CurationDocument = Schema.Struct({
  version: Schema.Literal(1),
  keyed: Schema.Record(ServiceId, KeyedService),
  worksNowRule: Schema.NonEmptyString,
  catalog: Schema.Array(CatalogIdentity).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    ),
  ),
  priority: Schema.Array(ServiceId).check(Schema.isUnique()),
  entries: Schema.Array(CurationEntry).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    ),
  ),
})
/** GitHub accepts fine-grained and classic personal tokens; instruction and transport policy
 * live in curation data. See https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens.
 * Decode once at module ingress so Begin and catalogue presentation use the same policy. */
const keyedCatalog = Schema.decodeUnknownSync(Schema.Record(ServiceId, KeyedService))(data.keyed)
export function keyedService(service: ServiceId) {
  return keyedCatalog[service]
}

/** Address registration reuses declared header policy by the complete endpoint, never by a
 * host heuristic: two services on the same host may require different authorization headers. */
export function keyedAddress(address: URL) {
  return Object.values(keyedCatalog).find((service) => service.address.href === address.href)
}

const decodeCuration = Schema.decodeUnknownEffect(CurationDocument)

/** The checked-in judgements failed to decode; the page says so instead of listing everything. */
const missingCuration = () =>
  ServiceUnavailable.make({
    service: 'connections',
    message: 'The integration catalogue needs a curation update.',
  })

/** Compare both identity and name: renaming an upstream entry can invalidate its judgement. */
export function coversCatalog(
  document: typeof CurationDocument.Type,
  catalog: readonly { readonly id: ServiceId; readonly name: string }[],
) {
  const entries = new Map(document.entries.map((entry) => [entry.id, entry]))
  return catalog.every((service) => {
    const entry = entries.get(service.id)
    return entry !== undefined && entry.name === service.name
  })
}

/** Startup decodes once, before requests; malformed data never becomes an empty catalogue. */
export const loadCuration = Effect.fn('Connections.loadCuration')(
  function* () {
    const document = yield* decodeCuration(data)
    if (
      !coversCatalog(document, document.catalog) ||
      document.entries.length !== document.catalog.length
    ) {
      return yield* Effect.fail(missingCuration())
    }
    return curatedSearch(document)
  },
  Effect.mapError(() => missingCuration()),
)

/** Personal-key declarations override obsolete OAuth catalogue hints; other services retain inspection. */
function decorate(service: Service, entry: typeof CurationEntry.Type) {
  const keyed = keyedService(service.id)
  const authorization = keyed === undefined ? service.authorization : personalKeyAuthorization()
  const worksNow = entry.worksNow && !ServiceAuthorization.guards.SetupRequired(authorization)
  return Service.make({
    id: service.id,
    name: service.name,
    description: keyed === undefined ? service.description : keyed.instruction,
    mark: service.mark,
    authorization: worksNow ? authorization : ServiceAuthorization.cases.SetupRequired.make({}),
    curation: { kind: entry.kind, auth: entry.auth, worksNow },
  })
}

/** Tier precedes name relevance; popularity breaks ties without reordering the upstream snapshot. */
function tierRank(tier: typeof CurationEntry.Type.tier) {
  return Match.value(tier).pipe(
    Match.when('Core', () => 0),
    Match.when('Useful', () => 1),
    Match.when('Niche', () => 2),
    Match.when('Hide', () => 3),
    Match.exhaustive,
  )
}

/** One service with where the curation puts it: its tier and its place among the shown ones. */
interface Placed {
  readonly service: Service
  readonly tier: typeof CurationEntry.Type.tier
  readonly place: number
}

/** Only a complete, normalized service name reveals a hidden row; descriptions never leak it. */
function visible({ service, tier }: Placed, query: string) {
  const name = service.name.toLowerCase().trim()
  if (tier === 'Hide') return query.length > 0 && name === query
  if (query.length === 0) return tier === 'Core' || tier === 'Useful'
  return name.includes(query)
}

/**
 * One indexed policy owns filtering, count and ordering. No provider calls run on search. The
 * upstream catalogue grows daily, so a service with no judgement yet is Niche: found by its name,
 * never offered unasked, and without curation facts nobody has checked. It never takes the page down.
 */
export function curatedSearch(document: typeof CurationDocument.Type) {
  const entries = new Map(document.entries.map((entry) => [entry.id, entry]))
  const places = new Map(document.priority.map((id, index) => [id, index]))
  const last = document.priority.length
  const place = (service: Service): Placed => {
    const entry = entries.get(service.id)
    if (entry === undefined) return { service, tier: 'Niche', place: last }
    const listed = places.get(entry.id)
    return {
      service: decorate(service, entry),
      tier: entry.tier,
      place: listed === undefined ? last : listed,
    }
  }
  return (services: readonly Service[], query: string) => {
    const normalized = query.trim().toLowerCase()
    const placed = services.map(place)
    const ordered = Arr.sort(
      placed.filter((entry) => visible(entry, normalized)),
      Order.combineAll([
        Order.mapInput(Order.Number, (entry: Placed) => tierRank(entry.tier)),
        Order.mapInput(Order.Number, (entry: Placed) => relevance(entry.service.name, normalized)),
        Order.mapInput(Order.Number, (entry: Placed) => entry.place),
      ]),
    )
    return ServiceCatalog.cases.Ready.make({
      services: ordered.slice(0, 24).map(({ service }) => service),
      total: placed.filter(({ tier }) => tier !== 'Hide').length,
    })
  }
}

/** Exact names precede prefixes and substrings inside their usefulness tier. */
function relevance(name: string, query: string) {
  if (query.length === 0) return 0
  const normalized = name.trim().toLowerCase()
  if (normalized === query) return 0
  return normalized.startsWith(query) ? 1 : 2
}

/** The deployed declaration has one token field; provider method labels are not field titles. */
export function personalKeyAuthorization() {
  return ServiceAuthorization.cases.Key.make({
    fields: [{ name: 'token', label: 'Personal access token' }],
  })
}
