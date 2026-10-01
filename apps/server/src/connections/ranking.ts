import { ServiceAuthorization, type Service } from '@vivid/contracts'
import { Array as Arr, Order } from 'effect'

/** Names alone determine relevance. Stable sort preserves the catalog's popularity order
 * within name ranks and availability. An empty query gives every name the same rank, so all
 * connectable services precede setup-required ones without changing their popularity order.
 */
export function rankServices(services: readonly Service[], query: string): readonly Service[] {
  const normalized = query.trim().toLowerCase()
  const matches = services.map((service) => {
    const name = service.name.toLowerCase()
    const rank = normalized.length === 0 ? 0 : nameRank(name, normalized)
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

/** Exact names outrank prefixes, which outrank substrings. */
function nameRank(name: string, query: string) {
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  return 2
}
