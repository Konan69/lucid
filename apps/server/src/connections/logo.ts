import { getDomain } from 'tldts'
import { Service } from '@vivid/contracts'
import type { ExecutorServiceEntry } from './executor.ts'

/** Project a catalog entry into a Service: its icon is found by the site the catalog names. */
export function catalogService(entry: typeof ExecutorServiceEntry.Type): Service {
  return Service.make({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    mark: entry.icon === null ? serviceLogo(entry.domain) : entry.icon,
    authorization: entry.authorization,
  })
}

/**
 * The address of a site's icon, ready to draw: clients use it as sent, because a catalog entry's
 * own icon (Executor's `icons[].src`) is a whole address with no size to add.
 *
 * It was `integrations.sh/logo/<domain>`, the service Executor's own pages use
 * (packages/ui/src/contracts/icons.ts `faviconUrl`). That service answers with the site's
 * 16-pixel favicon whatever size is asked (measured 4 October 2026: context7.com 15x16,
 * deepwiki.com 16x16), which is a blur in a 44-pixel tile. Google's icon service returns the
 * site's largest icon up to the size asked (74x75 and 128x128 for the same two). Only the
 * registrable domain is sent, never the address a Person gave. It answers only at its own sizes
 * and falls to the 16-pixel favicon for any other (asking for 88 returned 15x16 on production);
 * 128 covers every tile the clients draw at two or three times its drawn size.
 */
const ICONS = 'https://www.google.com/s2/favicons'

/** The icon for a catalog domain or an import's checked address; none for a name with no site. */
export function serviceLogo(address: string | null): string | null {
  if (address === null) return null
  const domain = getDomain(address)
  return domain === null ? null : `${ICONS}?domain=${domain}&sz=128`
}

/** How an added server's Service is identified: its checked address behind this prefix. */
export const IMPORTED = 'url:'

/**
 * The icon for a Connection, from its Service alone. An added server carries its address in its
 * Service id, so its site's icon can be named. A catalog Service does not, and gets none here:
 * the client draws its bundled logo for the service's name.
 */
export function connectionLogo(service: string): string | null {
  return service.startsWith(IMPORTED) ? serviceLogo(service.slice(IMPORTED.length)) : null
}
