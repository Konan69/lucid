import { getDomain } from 'tldts'
import { Service } from '@vivid/contracts'
import type { ExecutorServiceEntry } from './executor.ts'

/** Project optional catalog domain metadata explicitly so internal fields never leak into Service.
 * The transport owns retaining this field; missing metadata never permits guessing from a name.
 */
export function catalogService(
  entry: typeof ExecutorServiceEntry.Type & { readonly domain?: string | null },
): Service {
  return Service.make({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    mark: entry.domain === undefined ? null : serviceLogo(entry.domain),
    authorization: entry.authorization,
  })
}

/** Adapt Executor packages/ui/src/contracts/icons.ts faviconUrl: send only the registrable
 * catalog domain to the logo service. URL imports use their checked source address. Size belongs
 * to the client, so persisted service metadata contains no query parameters.
 */
export function serviceLogo(address: string | null): string | null {
  if (address === null) return null
  const domain = getDomain(address)
  return domain === null ? null : `https://integrations.sh/logo/${domain}`
}
