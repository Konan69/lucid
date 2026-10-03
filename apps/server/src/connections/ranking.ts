import { ServiceAuthorization, type Service } from '@vivid/contracts'
import { Array as Arr, Order } from 'effect'

/** Exact names and their catalog aliases define the empty-search order in one server-owned list. */
const preferredServices: readonly (readonly string[])[] = [
  ['google workspace'],
  ['gmail'],
  ['google calendar'],
  ['google drive', 'drive'],
  ['microsoft 365'],
  ['outlook', 'microsoft outlook'],
  ['slack'],
  ['notion'],
]

/** Names alone determine search relevance. Empty queries show common services first; stable
 * sort preserves catalog popularity within each rank and availability. Other services retain
 * their existing connectable-before-setup order, and typed queries keep their relevance ranks.
 */
export function rankServices(services: readonly Service[], query: string): readonly Service[] {
  const normalized = query.trim().toLowerCase()
  const matches = services.map((service) => {
    const name = service.name.toLowerCase()
    const rank = normalized.length === 0 ? defaultRank(name) : nameRank(name, normalized)
    const unavailable = ServiceAuthorization.guards.SetupRequired(service.authorization) ? 1 : 0
    return { service, rank: rank * 2 + unavailable, matches: name.includes(normalized) }
  })
  return Arr.sortWith(
    matches.filter((entry) => entry.matches),
    (entry) => entry.rank,
    Order.Number,
  )
    .slice(0, 24)
    .map((entry) => entry.service)
}

/** Only complete catalog names receive priority; a similarly named product is a different service. */
function defaultRank(name: string) {
  const index = preferredServices.findIndex((names) => names.includes(name.trim()))
  return index === -1 ? preferredServices.length : index
}

/** Exact names outrank prefixes, which outrank substrings. */
function nameRank(name: string, query: string) {
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  return 2
}
