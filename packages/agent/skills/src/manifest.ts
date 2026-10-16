import { Array as Arr } from 'effect'
import { SkillId } from '@vivid/contracts'

/** Display names and suggestion dependencies are shared by the server and runtime. Descriptions
 * and procedure bodies live only in SKILL.md; adding a name also extends the mount-map key type. */
const definitions = [
  {
    runtimeName: 'connect-a-service',
    displayName: 'Connect a service',
    about: 'Connects the services you need so your work can move forward.',
    starter: true,
    needs: [
      'find_integrations',
      'find_tools',
      'connect',
      'add_integration',
      'test_integration',
      'ask_person',
    ],
    connections: [],
  },
  {
    runtimeName: 'work-in-a-signed-in-browser',
    displayName: 'Work in a signed-in browser',
    about: 'Works through signed-in pages with you and checks that each step succeeded.',
    starter: false,
    needs: ['browse', 'use_desktop', 'ask_person', 'find_tools', 'connect'],
    connections: [],
  },
  {
    runtimeName: 'deep-research',
    displayName: 'Deep research',
    about:
      'Investigates your question, checks the evidence, and brings you an answer with sources.',
    starter: false,
    needs: [
      'find_tools',
      'use_tool',
      'connect',
      'read_page',
      'browse',
      'search_library',
      'run_code',
      'ask_person',
    ],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
  {
    runtimeName: 'triage-my-inbox',
    displayName: 'Triage my inbox',
    about:
      'Sorts your inbox into what needs you and what does not, and proposes the next step for each.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'recall', 'ask_person'],
    connections: [['Gmail', 'Outlook', 'Microsoft Outlook']],
  },
  {
    runtimeName: 'draft-a-reply',
    displayName: 'Draft a reply',
    about: 'Drafts a considered reply in your voice for you to review.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'search_library', 'recall', 'ask_person'],
    connections: [['Gmail', 'Outlook', 'Microsoft Outlook']],
  },
  {
    runtimeName: 'morning-brief',
    displayName: 'Morning brief',
    about: 'Brings your meetings, urgent messages, and commitments into a short brief for the day.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'recall', 'ask_person'],
    connections: [
      ['Gmail', 'Outlook', 'Microsoft Outlook'],
      ['Google Calendar', 'Outlook', 'Microsoft Outlook'],
    ],
  },
  {
    runtimeName: 'find-time-and-schedule',
    displayName: 'Find time and schedule',
    about: 'Finds suitable meeting times and checks the details with you before booking.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'recall', 'ask_person'],
    connections: [['Google Calendar', 'Outlook', 'Microsoft Outlook']],
  },
  {
    runtimeName: 'prepare-for-a-meeting',
    displayName: 'Prepare for a meeting',
    about: 'Prepares you for a meeting with the context, decisions, and questions that matter.',
    starter: false,
    needs: [
      'find_tools',
      'use_tool',
      'connect',
      'search_library',
      'recall',
      'read_page',
      'ask_person',
    ],
    connections: [['Google Calendar', 'Outlook', 'Microsoft Outlook']],
  },
  {
    runtimeName: 'chase-an-outcome',
    displayName: 'Chase an outcome',
    about: 'Checks progress on your commitment and the evidence before calling it done.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'ask_person'],
    connections: [['Gmail', 'Outlook', 'Microsoft Outlook', 'Slack', 'Linear', 'Asana']],
  },
  {
    runtimeName: 'remember-and-correct-preferences',
    displayName: 'Remember and correct preferences',
    about: 'Remembers, corrects, or forgets your working preferences at your request.',
    starter: true,
    needs: ['recall', 'remember', 'read_note', 'write_note', 'delete_note', 'ask_person'],
    connections: [],
  },
  {
    runtimeName: 'learn-how-we-do-this',
    displayName: 'Learn how we do this',
    about: 'Turns work you have verified into a reusable procedure for you to review and keep.',
    starter: true,
    needs: ['save_skill', 'read_skill', 'recall', 'ask_person', 'find_tools', 'connect'],
    connections: [],
  },
  {
    runtimeName: 'write-a-document',
    displayName: 'Write a document',
    about:
      'Writes a document you will keep, with real structure, and reads it back before handing it over.',
    starter: false,
    needs: ['write_document', 'read_document', 'search_library', 'ask_person'],
    connections: [],
  },
  {
    runtimeName: 'check-a-deliverable',
    displayName: 'Check a deliverable',
    about:
      'Looks at finished work the way you will see it and fixes what is wrong before handing it over.',
    starter: false,
    needs: ['read_document', 'write_document', 'browse', 'use_desktop', 'bash', 'ask_person'],
    connections: [],
  },
  {
    runtimeName: 'wide-research',
    displayName: 'Wide research',
    about:
      'Runs the same lookup across a long list and returns one table, with what was and was not found.',
    starter: false,
    needs: ['run_code', 'find_tools', 'use_tool', 'read_page', 'connect', 'ask_person'],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
  {
    runtimeName: 'plan-a-trip',
    displayName: 'Plan a trip',
    about: 'Researches a trip, checks that it works and keeps one itinerary for you to decide on.',
    starter: false,
    needs: [
      'find_tools',
      'use_tool',
      'connect',
      'read_page',
      'browse',
      'recall',
      'write_document',
      'read_document',
      'ask_person',
    ],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
  {
    runtimeName: 'shop-for-something',
    displayName: 'Shop for something',
    about:
      'Finds well-priced products that match what you asked for and checks each one is really available.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'read_page', 'browse', 'recall', 'ask_person'],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
  {
    runtimeName: 'find-a-place',
    displayName: 'Find a place',
    about:
      'Finds and compares restaurants, hotels, shops and other places, grounded in current sources.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'read_page', 'ask_person'],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
  {
    runtimeName: 'make-a-booking',
    displayName: 'Make a booking',
    about:
      'Reserves a flight, hotel, table or ticket for you, and confirms the exact terms with you first.',
    starter: false,
    needs: [
      'find_tools',
      'use_tool',
      'connect',
      'browse',
      'use_desktop',
      'recall',
      'remember',
      'ask_person',
    ],
    connections: [],
  },
  {
    runtimeName: 'forget-something',
    displayName: 'Forget something',
    about: 'Removes something you no longer want remembered and stops it from coming back.',
    starter: false,
    needs: [
      'recall',
      'read_note',
      'write_note',
      'delete_note',
      'read_document',
      'write_document',
      'ask_person',
    ],
    connections: [],
  },
  {
    runtimeName: 'first-conversation',
    displayName: 'First conversation',
    about:
      'Introduces Vivid in your first Thread, learns how you work and does one real task with you.',
    starter: false,
    needs: [
      'ask_person',
      'find_tools',
      'find_integrations',
      'activate_skill',
      'recall',
      'remember',
    ],
    connections: [],
  },
  {
    runtimeName: 'what-vivid-can-do',
    displayName: 'What Vivid can do',
    about:
      'Tells you what Vivid can do, knows and watches, from what is actually set up right now.',
    starter: false,
    needs: [
      'find_tools',
      'find_integrations',
      'recall',
      'list_watches',
      'search_library',
      'activate_skill',
      'read_skill',
    ],
    connections: [],
  },
  {
    runtimeName: 'find-pictures',
    displayName: 'Find pictures',
    about: 'Finds public pictures that match your description and keeps the source of each one.',
    starter: false,
    needs: ['find_tools', 'use_tool', 'connect', 'read_page', 'ask_person'],
    connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  },
] as const

export type BuiltinRuntimeName = (typeof definitions)[number]['runtimeName']

/** Authored metadata is trusted, literal-typed source; only loaded Markdown needs ingress parsing. */
export const manifest = definitions

/** Retain existing wire identities with the contract's branded SkillId constructor. */
export const builtinId = (displayName: string) =>
  SkillId.make(`builtin:${displayName.toLowerCase().replaceAll(' ', '-')}`)

const identities = new Set<SkillId>(manifest.map((entry) => builtinId(entry.displayName)))

/** Only the release manifest identifies built-in handles; saved names never determine scope. */
export const isBuiltin = (id: SkillId) => identities.has(id)

/** Both historical display names and native names belong permanently to the shipped catalogue. */
export const builtinNamed = (name: string) =>
  Arr.findFirst(manifest, (entry) =>
    [entry.runtimeName, entry.displayName].some(
      (reserved) => reserved.toLowerCase() === name.trim().toLowerCase(),
    ),
  )
