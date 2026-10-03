import { Procedure } from './procedure.ts'

/**
 * Adapted from Muse's shipped procedure, read in full at
 * `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/travel-planning/SKILL.md`.
 * Kept: smallest useful brief, whole-trip comparison, one canonical itinerary and separate
 * decision, evidence and provider states. Reserving stays with the booking procedure.
 */
export const procedure = Procedure.make({
  starter: false,
  name: 'Plan a trip',
  about: 'Researches a trip, checks that it works and keeps one itinerary for you to decide on.',
  useWhen: 'When a destination, date, route, stay or daily structure of a trip still needs a real choice.',
  needs: [
    'find_tools',
    'use_tool',
    'connect',
    'read_page',
    'browse',
    'recall',
    'write_document',
    'read_document',
    'show',
    'ask_person',
  ],
  connections: [['Search', 'Web Search', 'Brave Search', 'Tavily', 'Exa']],
  instructions: `Turn an open travel idea or draft itinerary into a coherent, feasible plan the Person can decide on. You do the research and coordination; the Person owns every choice that materially affects where they go, when, cost, comfort, flexibility or risk. If the item, dates and party are already concrete, that is a booking, not planning. A request to see prices is not a request to book; when told to finish planning first, keep to that.

Build the smallest useful brief from the request, \`recall\` and the connected calendar and mail found with \`find_tools\` and read with \`use_tool\`, before asking anything; offer \`connect\` for search if it is missing. Capture only what changes the plan: the experience wanted and fixed anchors, travellers and their constraints, origin, dates and flexibility, budget and whether it is a ceiling or a target, pace, and stay and transport preferences. Ask with \`ask_person\` only for a fact that changes the candidate set. A remembered preference is a provisional default, not permission to commit. Check candidate dates against the calendar and surface a conflict once; without a calendar, do not call the schedule fit verified.

Compare a small set of plans that trade off differently, judged on the whole trip: door-to-door time, connections and recovery margin, nights and transfers, total known cost and unknowns. Lead with one direction and why. Verify consequential facts with \`read_page\` or \`browse\`: place identity, opening dates and hours, travel times, pass rules and published prices, each with its source and the date checked. Reviews inform fit, not current operation. A dead link is a source failure, not proof of closure.

Keep one itinerary with \`write_document\`, read with \`read_document\` before each revision, in local time with transit, buffers and a backup for any fragile anchor. Flag an overloaded day instead of compressing it. Keep three states apart: proposed, selected or rejected by the Person; unchecked, estimated or verified; and not checked, available, held or confirmed by the provider. Never call an unverified item secured or confirmed. Use \`show\` for one bounded choice at a time. Reserving or paying needs its own Approval.`,
})
