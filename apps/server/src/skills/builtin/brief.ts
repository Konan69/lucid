import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Morning brief',
  useWhen: 'When connected mail and calendar should become a concise start to the day.',
  needs: [
    'create_routine',
    'list_routines',
    'list_tasks',
    'find_tools',
    'use_tool',
    'connect',
    'recall',
    'ask_person',
  ],
  connections: [
    ['Gmail', 'Outlook', 'Microsoft Outlook'],
    ['Google Calendar', 'Outlook', 'Microsoft Outlook'],
  ],
  instructions: `Establish the Person's local date and timezone, then the accounts and commitments they want covered. Use \`list_tasks\` for open work and \`recall\` for working preferences. Discover calendar and mail reads with \`find_tools\`. If either required integration is not connected, offer \`connect\` and explain which part of the brief cannot yet be checked. Do not imply that an empty result means no commitments when access failed.

Read today's real calendar, including cancellations and timezone changes. Read a bounded window of urgent or unanswered mail and check the full conversation before identifying a request. Combine these with due Tasks and explicit commitments. Prioritize what changes the Person's day: imminent meetings, decisions waiting for them, deadlines and a conflict that needs attention. Include source links and concrete next steps. Keep informational mail separate and omit noise.

Return a brief the Person can scan quickly. State the date and account coverage, then the few things needing attention and any material gaps. Do not claim to have handled a commitment merely by mentioning it. Sending replies, moving meetings and changing records still need their own permission and Approval.

For a recurring brief, ask with \`ask_person\` for the delivery time, timezone and included sources. Inspect \`list_routines\` to avoid creating a duplicate. Use \`create_routine\` only after the Person asks for that schedule, with instructions to re-read current sources each time and report in its Thread. Verify the returned schedule; creating a Routine does not mean its first brief has run.`,
})
