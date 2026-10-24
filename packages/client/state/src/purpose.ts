import type { Service } from '@vivid/contracts'
import { Array as Arr, Option } from 'effect'

/**
 * What a Person uses a service for, in the order Integrations shows the groups on every device:
 * everyday things first (mail, files, chat), then work, then the specialist tools.
 *
 * The browser and the phone each had this whole module, word for word. It is here so a service
 * is found under the same heading everywhere and a newly placed service is placed once; each app
 * only draws the groups.
 */
const PURPOSES = [
  'Mail and calendar',
  'Files and notes',
  'Chat and meetings',
  'Work tools',
  'Design',
  'Sales and research',
  'Code and data',
  'More',
] as const
export type IntegrationPurpose = (typeof PURPOSES)[number]

/**
 * The purpose of each service Vivid can place, by the whole name the catalog gives it. The
 * catalog says how widely a service is used and nothing of what kind it is, so until it does the
 * well-known ones are placed here. A name that is not here is not guessed at: it goes under
 * "More", in the catalog's own order.
 */
const BY_NAME = {
  gmail: 'Mail and calendar',
  'google calendar': 'Mail and calendar',
  'outlook mail': 'Mail and calendar',
  'outlook calendar': 'Mail and calendar',
  'superhuman mail': 'Mail and calendar',
  calendly: 'Mail and calendar',
  'google tasks': 'Mail and calendar',
  'microsoft to do': 'Mail and calendar',

  'google drive': 'Files and notes',
  'google docs': 'Files and notes',
  'google sheets': 'Files and notes',
  'google slides': 'Files and notes',
  'google forms': 'Files and notes',
  'microsoft excel': 'Files and notes',
  onedrive: 'Files and notes',
  dropbox: 'Files and notes',
  box: 'Files and notes',
  notion: 'Files and notes',
  airtable: 'Files and notes',

  slack: 'Chat and meetings',
  'google chat': 'Chat and meetings',
  'google meet': 'Chat and meetings',
  'microsoft teams': 'Chat and meetings',
  discord: 'Chat and meetings',
  telegram: 'Chat and meetings',
  whatsapp: 'Chat and meetings',
  zoom: 'Chat and meetings',
  'zoom for claude': 'Chat and meetings',
  granola: 'Chat and meetings',
  fireflies: 'Chat and meetings',
  intercom: 'Chat and meetings',
  zendesk: 'Chat and meetings',

  asana: 'Work tools',
  'atlassian rovo': 'Work tools',
  jira: 'Work tools',
  confluence: 'Work tools',
  linear: 'Work tools',
  trello: 'Work tools',
  clickup: 'Work tools',
  monday: 'Work tools',
  todoist: 'Work tools',
  'microsoft planner': 'Work tools',
  zapier: 'Work tools',

  canva: 'Design',
  figma: 'Design',
  gamma: 'Design',
  excalidraw: 'Design',
  'mermaid chart': 'Design',
  lucid: 'Design',
  miro: 'Design',
  webflow: 'Design',

  hubspot: 'Sales and research',
  salesforce: 'Sales and research',
  zoominfo: 'Sales and research',
  'apollo.io': 'Sales and research',
  clay: 'Sales and research',
  ahrefs: 'Sales and research',
  indeed: 'Sales and research',
  linkedin: 'Sales and research',
  'intuit mailchimp': 'Sales and research',
  stripe: 'Sales and research',
  shopify: 'Sales and research',
  's&p global': 'Sales and research',
  'pitchbook premium': 'Sales and research',

  github: 'Code and data',
  gitlab: 'Code and data',
  bitbucket: 'Code and data',
  supabase: 'Code and data',
  vercel: 'Code and data',
  netlify: 'Code and data',
  cloudflare: 'Code and data',
  sentry: 'Code and data',
  datadog: 'Code and data',
  posthog: 'Code and data',
  'hugging face': 'Code and data',
  'microsoft learn': 'Code and data',
  'google cloud bigquery': 'Code and data',
  'google bigquery': 'Code and data',
} satisfies Record<string, IntegrationPurpose>

const PLACED = new Map<string, IntegrationPurpose>(Object.entries(BY_NAME))

/** Where a service goes: its purpose when Vivid can place it, "More" when it cannot. */
const purposeOf = (service: Service): IntegrationPurpose =>
  Option.getOrElse(
    Option.fromUndefinedOr(PLACED.get(service.name.trim().toLocaleLowerCase())),
    (): IntegrationPurpose => 'More',
  )

/**
 * The catalog's answer in groups, each group in the catalog's own order (most used first) and
 * the groups in the order of `PURPOSES`. A purpose nothing answered to is left out.
 */
export function byPurpose(services: ReadonlyArray<Service>): ReadonlyArray<{
  readonly purpose: IntegrationPurpose
  readonly services: ReadonlyArray<Service>
}> {
  const groups = Arr.groupBy(services, purposeOf)
  return PURPOSES.flatMap((purpose) => {
    const members = groups[purpose]
    return members === undefined ? [] : [{ purpose, services: members }]
  })
}
