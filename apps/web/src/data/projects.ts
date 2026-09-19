/* Fixtures for the Projects screen, modelled on docs/12-company-and-projects.md.
   A project is a real work container: members, participating teams,
   conversations, and child projects recursively. Children inherit members,
   permissions, context, and service access. */

export type ProjectMember = { name: string }

export type Project = {
  id: string
  name: string
  /** What this project is actually for, in the user's language. */
  brief: string
  cover: string
  members: ProjectMember[]
  teams: string[]
  conversationCount: number
  lastActive: string
  /** Titles of conversations that live in this project. */
  conversations: string[]
  children?: Project[]
}

export const projects: Project[] = [
  {
    id: 'p-kashplus',
    name: 'Kash Plus',
    brief: 'One app for trading, earning, and payments',
    cover: '/covers/kashplus.png',
    members: [{ name: 'You' }, { name: 'Adejoke' }, { name: 'Sam' }],
    teams: ['Product', 'Legal'],
    conversationCount: 6,
    lastActive: '10:05',
    conversations: [
      'Kash Plus PRD review',
      'Worldstreet API access request',
      'Payments partner shortlist',
    ],
    children: [
      {
        id: 'p-kashplus-payments',
        name: 'Payments',
        brief: 'Cross-border flows and the fee table',
        cover: '/covers/kashplus.png',
        members: [{ name: 'You' }, { name: 'Adejoke' }],
        teams: ['Product', 'Legal'],
        conversationCount: 3,
        lastActive: 'Yesterday',
        conversations: ['Cross-border fee model', 'Recipient flow walkthrough'],
      },
    ],
  },
  {
    id: 'p-interlink',
    name: 'Interlink',
    brief: 'Wi-Fi plus LoRa when the internet is down',
    cover: '/covers/interlink.png',
    members: [{ name: 'You' }, { name: 'Marco' }],
    teams: ['Engineering', 'Ops'],
    conversationCount: 4,
    lastActive: '9:58',
    conversations: ['Publish the Interlink spec', 'Threat model for public devices'],
    children: [
      {
        id: 'p-interlink-lora',
        name: 'LoRa mesh',
        brief: 'Long-range, low-power messaging',
        cover: '/covers/interlink.png',
        members: [{ name: 'You' }, { name: 'Marco' }],
        teams: ['Engineering'],
        conversationCount: 2,
        lastActive: 'Mon',
        conversations: ['Range test plan'],
      },
    ],
  },
  {
    id: 'p-rwa',
    name: 'RWA market',
    brief: 'Bringing real-world assets on-chain',
    cover: '/covers/rwa.png',
    members: [{ name: 'You' }, { name: 'John' }, { name: 'Priya' }],
    teams: ['Legal', 'Product'],
    conversationCount: 5,
    lastActive: 'Yesterday',
    conversations: ['RWA market one-pager', 'Platform comparison', 'Custody questions for counsel'],
  },
  {
    id: 'p-kash-engine',
    name: 'KASH engine',
    brief: 'Stablecoin in, quoted KASH out',
    cover: '/covers/kash.png',
    members: [{ name: 'You' }, { name: 'Dee' }],
    teams: ['Engineering'],
    conversationCount: 3,
    lastActive: '8:02',
    conversations: ['KASH fee quoting edge cases', 'Pool approval flow'],
  },
  {
    id: 'p-arkchain',
    name: 'ARKchain',
    brief: 'The chain under the SuperApp',
    cover: '/covers/arkchain.png',
    members: [{ name: 'You' }, { name: 'Marco' }, { name: 'Dee' }, { name: 'Priya' }],
    teams: ['Engineering', 'DevRel'],
    conversationCount: 7,
    lastActive: 'now',
    conversations: [
      'Draft the ARKchain workstream plan',
      'Fee abstraction options',
      'Testnet gates',
    ],
  },
  {
    id: 'p-arkade',
    name: 'Arkademy',
    brief: 'Courses, tutors, and paid learning',
    cover: '/covers/arkade.png',
    members: [{ name: 'You' }, { name: 'Sam' }],
    teams: ['Marketing', 'Ops'],
    conversationCount: 4,
    lastActive: 'Aug 30',
    conversations: ['Arkademy course pricing', 'Launch checklist', 'Tutor payout flow'],
  },
]

export function findProject(id: string, list: Project[] = projects): Project | null {
  for (const p of list) {
    if (p.id === id) return p
    if (p.children) {
      const hit = findProject(id, p.children)
      if (hit) return hit
    }
  }
  return null
}

export function countProjects(list: Project[]): number {
  return list.reduce((n, p) => n + 1 + (p.children ? countProjects(p.children) : 0), 0)
}

/** The chain of parents above a project, nearest first. */
export function pathTo(id: string, list: Project[] = projects, trail: Project[] = []): Project[] {
  for (const p of list) {
    if (p.id === id) return trail
    if (p.children) {
      const hit = pathTo(id, p.children, [...trail, p])
      if (hit.length) return hit
    }
  }
  return []
}
