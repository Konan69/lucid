import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Prepare for a meeting',
  useWhen: 'When a connected calendar and relevant sources can ground meeting preparation.',
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
  instructions: `Identify the meeting by title, date and participants. Discover the calendar read with \`find_tools\`, and offer \`connect\` if the needed integration is not connected. If the Person supplies an invitation instead, work from it and state what cannot be verified. Read the current event to check its purpose, time, timezone, attendees and linked material; an old memory does not establish the latest agenda.

Use \`search_library\` for relevant internal documents and \`recall\` for prior decisions and relationship context. Discover connected mail or work tools for the specific related conversations. If those integrations are missing, offer them and explain the narrower preparation available now. Use \`read_page\` for public sources and follow original references. Keep private information within the Thread's permitted audience.

Build a brief around the meeting's intended outcome: what has happened, decisions already made, open questions, the Person's role and a proposed agenda. Distinguish known facts from guesses about other participants. Include links for statements that affect a decision and flag conflicting or stale material. Use \`ask_person\` for the one missing objective that would materially change the preparation.

Return the preparation directly in the Thread, with a short opening, decision points and questions worth asking. Before calling it ready, check that it matches the current meeting and that cited documents were actually read. Do not claim a file was published. Updating the event, sharing the brief or contacting attendees requires explicit scope and the appropriate Approval; preparing a brief alone authorizes none of those actions.`,
})
