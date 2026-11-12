import { ServiceAuthorization, ServiceId } from '@vivid/contracts'
import { Array as Arr, Order, Result, Schema } from 'effect'
import data from './curation.json' with { type: 'json' }
import { KeyedService } from './keyed.ts'

/**
 * Vivid's judgements over Executor's app feed (`EXECUTOR_CATALOG_URL`, catalog.executor.sh),
 * keyed by the feed's own ids. `supersedes` names the feed apps a Vivid-authored service replaces,
 * so one service is never listed twice. `priority` is the order an empty search shows. `hide`
 * holds Executor packages a Person is never offered: the host's built-in Executor app has the
 * package `executor` (executor apps/hosted/server/src/contracts/catalog.ts
 * `executorCatalogPackage`), and its id is the deployment's own address, so it cannot be named
 * by id here.
 */
const CurationDocument = Schema.Struct({
  version: Schema.Literal(2),
  supersedes: Schema.Record(ServiceId, ServiceId),
  priority: Schema.Array(ServiceId).check(Schema.isUnique()),
  hide: Schema.Array(Schema.NonEmptyString),
  keyed: Schema.Record(
    ServiceId,
    Schema.Struct({ name: Schema.NonEmptyString, ...KeyedService.fields }),
  ),
})

/** The file is checked in, so one that does not decode is a broken build: the schema's own
 * error ends the load, and the server does not start without the policy every keyed sign-in and
 * every catalog search is held to. */
const curation = Result.getOrThrow(Schema.decodeUnknownResult(CurationDocument)(data))

export function keyedService(service: ServiceId) {
  return curation.keyed[service]
}

/** The checked-in keyed sources stay Vivid-owned services whatever the feed lists. */
export const keyedServices = Object.entries(curation.keyed).map(([id, policy]) => ({
  id: ServiceId.make(id),
  name: policy.name,
  policy,
}))

/** Address registration reuses declared header policy by the complete endpoint, never by a
 * host heuristic: two services on the same host may require different authorization headers. */
export function keyedAddress(address: URL) {
  return Object.values(curation.keyed).find((service) => service.address.href === address.href)
}

/** The deployed declaration has one token field; provider method labels are not field titles. */
export function personalKeyAuthorization() {
  return ServiceAuthorization.cases.Key.make({
    fields: [{ name: 'token', label: 'Personal access token' }],
  })
}

/** Whether an Executor catalog package is kept out of every list a Person or the model reads. */
export function hiddenPackage(name: string) {
  return curation.hide.includes(name)
}

/** What search reads of a catalog entry. The adapter's entry carries the feed's category. */
interface Searchable {
  readonly id: ServiceId
  readonly name: string
  readonly description: string
  readonly category: string | null
}

/**
 * The installed catalog: Vivid's authored services, then the feed's apps without the ones an
 * authored service supersedes and without repeats (the feed listed `google-maps`,
 * `azure-blob-storage` and `sap-s4hana-cloud` twice on 12 November 2026). An authored service
 * takes the category of the feed app it supersedes, so "email" finds Gmail as it finds any mail app.
 */
export function curateCatalog<E extends Searchable>(authored: readonly E[], feed: readonly E[]) {
  const inherited = new Map(
    Arr.filterMap(feed, (entry) => {
      const by = curation.supersedes[entry.id]
      return by === undefined || entry.category === null
        ? Result.failVoid
        : Result.succeed([by, entry.category] as const)
    }).toReversed(),
  )
  const owned = new Set(authored.map((entry) => entry.id))
  const listed = Arr.dedupeWith(
    feed.filter((entry) => curation.supersedes[entry.id] === undefined && !owned.has(entry.id)),
    (left, right) => left.id === right.id,
  )
  return [
    ...authored.map((entry) => ({ ...entry, category: inherited.get(entry.id) ?? entry.category })),
    ...listed,
  ]
}

/** Words a request carries no meaning in: "can you hook up Linear for me" searches for Linear. */
const stopwords = new Set(
  'a an and are can for from get hook i in into is it me my of on or please set the to up use want with you your keep eye connect integration integrations'.split(
    ' ',
  ),
)

/** Lowercased letter and digit runs, stopwords dropped, a plural `s` folded ("issues" is "issue"). */
export function searchWords(text: string): ReadonlySet<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(
    Arr.filterMap(words, (word) =>
      stopwords.has(word)
        ? Result.failVoid
        : Result.succeed(word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word),
    ),
  )
}

function overlap(query: ReadonlySet<string>, text: string) {
  return [...searchWords(text)].filter((word) => query.has(word)).length
}

/** Where a query met an entry. A lower field ranks first; more hits rank first within it. */
interface Hit<E> {
  readonly entry: E
  readonly field: number
  readonly hits: number
  readonly place: number
  readonly index: number
}

/**
 * The exact name first. Then a priority service the query names or whose category it names, so
 * "email" leads with Gmail and "crm" with HubSpot rather than every app called "… Email" or
 * "… CRM". Then any other name or id word, then the category and description alone. Category
 * words count twice. An entry the query does not reach is not a result.
 */
function hit<E extends Searchable>(entry: E, query: string, words: ReadonlySet<string>) {
  if (entry.name.trim().toLowerCase() === query) return Result.succeed({ field: 0, hits: 0 })
  const named = overlap(words, `${entry.name} ${entry.id}`)
  const category = overlap(words, entry.category === null ? '' : entry.category)
  const hits = named + category * 2 + overlap(words, entry.description)
  if (hits === 0) return Result.failVoid
  if (named + category > 0 && places.has(entry.id)) return Result.succeed({ field: 1, hits })
  return Result.succeed({ field: named > 0 ? 2 : 3, hits })
}

const byHit = Order.combineAll([
  Order.mapInput(Order.Number, (hit: Hit<unknown>) => hit.field),
  Order.mapInput(Order.flip(Order.Number), (hit: Hit<unknown>) => hit.hits),
  Order.mapInput(Order.Number, (hit: Hit<unknown>) => hit.place),
  Order.mapInput(Order.Number, (hit: Hit<unknown>) => hit.index),
])

/** Priority places by the id each app is listed under: a superseded feed app by its replacement,
 * at the first place any feed app it replaces holds (`gmail` and `google` both name Gmail). */
const places = new Map(
  Arr.dedupeWith(
    curation.priority.map((id) => curation.supersedes[id] ?? id),
    (left, right) => left === right,
  ).map((id, index) => [id, index] as const),
)

/**
 * The one catalog search the app (`FindServices`) and the model (`find_integrations`, the offers
 * `find_tools` makes) share. It reads the catalog already in memory and calls no provider.
 * A query with no words left answers with the priority services in priority order. Otherwise
 * every entry the query reaches is returned, best first; priority and then catalog order break
 * ties. Callers take as many as they show.
 */
export function searchCatalog<E extends Searchable>(entries: readonly E[], query: string) {
  const normalized = query.trim().toLowerCase()
  const words = searchWords(normalized)
  const last = places.size
  if (words.size === 0)
    return Arr.sort(
      entries.filter((entry) => places.has(entry.id)),
      Order.mapInput(Order.Number, (entry: E) => places.get(entry.id) ?? last),
    )
  const hits = Arr.filterMap(entries, (entry, index) =>
    Result.map(hit(entry, normalized, words), ({ field, hits }) => ({
      entry,
      field,
      hits,
      place: places.get(entry.id) ?? last,
      index,
    })),
  )
  return Arr.sort(hits, byHit).map(({ entry }) => entry)
}
