import { getDomain } from 'tldts'
import { Service } from '@vivid/contracts'
import type { ExecutorServiceEntry } from './executor.ts'

/** Preserve catalog icon addresses; authored services may instead declare their known site. */
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

/**
 * Where the catalog's Google services keep their pages, which the catalog itself does not say
 * (Executor beta.23 entries carry an icon and no site, `ExecutorServiceEntry.domain`). A path
 * tells apart the services that share a host.
 */
const GOOGLE_SITES = new Map([
  ['google/gmail', 'mail.google.com'],
  ['google/calendar', 'calendar.google.com'],
  ['google/drive', 'drive.google.com'],
  ['google/docs', 'docs.google.com/document'],
  ['google/sheets', 'docs.google.com/spreadsheets'],
  ['google/tasks', 'tasks.google.com'],
])

/**
 * A curated server's id names its site with dots as dashes and an `-mcp` suffix
 * (`curated/notion-com-mcp`, `curated/linear-app-mcp` in `curation.json`).
 */
const CURATED = /^curated\/([a-z0-9-]+)-([a-z]+)-mcp$/u

/**
 * Where links to a service live (`Connection.site`): an added server's registrable domain, a
 * Google service's page, or a curated server's site. Null for every other catalog entry.
 */
export function connectionSite(service: string): string | null {
  if (service.startsWith(IMPORTED)) return getDomain(service.slice(IMPORTED.length))
  const google = GOOGLE_SITES.get(service)
  if (google !== undefined) return google
  const curated = CURATED.exec(service)
  return curated === null ? null : `${curated[1]}.${curated[2]}`
}
