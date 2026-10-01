import type { Service } from '@vivid/contracts'
import { Array as Arr, Order } from 'effect'

/** Names alone determine relevance. Stable sort preserves the catalog's popularity order
 * within exact, prefix and substring matches; an empty query returns its first 24 services.
 */
export function rankServices(services: readonly Service[], query: string): readonly Service[] {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return services.slice(0, 24)
  const matches = services.map((service) => {
    const name = service.name.toLowerCase()
    const rank = nameRank(name, normalized)
    return { service, rank, matches: name.includes(normalized) }
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
