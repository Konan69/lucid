import { Procedure } from './procedure.ts'

/** Shipped guidance keeps completion evidence and permission beside the steps. */
export const procedure = Procedure.make({
  starter: false,
  name: 'Find time and schedule',
  about: 'Finds suitable meeting times and checks the details with you before booking.',
  useWhen: 'When connected calendars can establish availability and a concrete meeting.',
  needs: ['find_tools', 'use_tool', 'connect', 'recall', 'ask_person'],
  connections: [['Google Calendar', 'Outlook', 'Microsoft Outlook']],
  instructions: `Clarify the meeting's purpose, required people, duration, date window and location or call format. Use \`recall\` for working hours and timezone preferences, but treat them as preferences rather than proof of availability. Ask with \`ask_person\` when a participant or timezone cannot be identified confidently. Interpret dates in the Person's timezone and show the resulting local times.

Discover calendar and availability tools with \`find_tools\`. If the integration is not connected, offer \`connect\`; propose only provisional choices until actual availability can be checked. Read the relevant calendars or free/busy results through \`use_tool\`. Check all required participants where access permits, existing commitments, travel buffers, working hours and daylight-saving changes. If someone else's calendar is inaccessible, state that limitation and ask how their availability should be confirmed.

Offer a small set of suitable times with dates, timezones and the reason each works. Before creating anything, confirm the selected slot, attendees, title, duration, location and description. Recheck availability immediately before the authorized write, because an earlier free slot may have filled. Creation, invitations, rescheduling and cancellation follow the normal permission and Approval path for the exact action.

After creation, read back the calendar event and verify its time, participants and location against the approved proposal. Return the event link and any invitation state actually provided by the service. Do not say everyone accepted merely because invitations were sent. A failed or uncertain write is not a booking; check the existing event before proposing any retry.`,
})
